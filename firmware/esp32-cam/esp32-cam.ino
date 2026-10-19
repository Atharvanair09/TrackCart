#include "esp_camera.h"
#include <WiFi.h>
#include "esp_http_server.h"
#include "esp_timer.h"
#include "config.h"

httpd_handle_t camera_httpd = NULL;
bool camera_is_initialized = false;
bool wifi_is_connected = false;

// ===========================
// Camera Initialization
// ===========================
bool initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG; 
  
  // init with high specs to pre-allocate larger buffers
  if(psramFound()){
    config.frame_size = FRAMESIZE_UXGA; // UXGA
    config.jpeg_quality = 10;
    config.fb_count = 2;
  } else {
    config.frame_size = FRAMESIZE_SVGA;
    config.jpeg_quality = 12;
    config.fb_count = 1;
  }

  // camera init
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera initialization failed with error 0x%x\n", err);
    return false;
  }
  
  // --- Camera Configuration for Product Detection ---
  sensor_t * s = esp_camera_sensor_get();
  s->set_framesize(s, FRAMESIZE_VGA);  // Resolution: VGA (640x480)
  s->set_quality(s, 12);               // JPEG quality: 12
  s->set_brightness(s, 0);             // Brightness: 0
  s->set_contrast(s, 0);               // Contrast: 0
  s->set_saturation(s, 0);             // Saturation: 0
  s->set_sharpness(s, 0);              // Sharpness: 0
  s->set_whitebal(s, 1);               // White balance: enabled
  s->set_awb_gain(s, 1);               // AWB gain: enabled
  s->set_wb_mode(s, 0);                // Auto white balance mode
  s->set_exposure_ctrl(s, 1);          // Automatic exposure: enabled
  s->set_aec2(s, 0);                   // Night mode: disabled
  s->set_gain_ctrl(s, 1);              // Automatic gain: enabled
  s->set_lenc(s, 1);                   // Lens correction: enabled
  s->set_colorbar(s, 0);               // Color bar: disabled

  Serial.println("Camera initialization success");
  camera_is_initialized = true;
  return true;
}

// ===========================
// WiFi Initialization
// ===========================
void initWiFi() {
  Serial.print("WiFi connection attempt to ");
  Serial.println(WIFI_SSID);
  
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    wifi_is_connected = true;
    Serial.println("");
    Serial.println("WiFi connected");
    Serial.print("Assigned IP address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("");
    Serial.println("WiFi connection failed!");
  }
}

// ===========================
// HTTP Server Endpoints
// ===========================

// Handler for /capture
static esp_err_t capture_handler(httpd_req_t *req){
  camera_fb_t * fb = NULL;
  esp_err_t res = ESP_OK;

  int64_t t_fb_start = esp_timer_get_time();
  fb = esp_camera_fb_get();
  int64_t t_fb_end = esp_timer_get_time();
  if (!fb) {
    Serial.println("Capture request failure: Camera capture failed");
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Camera capture failed");
    Serial.printf("CAP_DIAG fb_get_fail fb_get_us=%lld\n",
                  (long long)(t_fb_end - t_fb_start));
    return ESP_FAIL;
  }

  // Ensure format is JPEG
  if (fb->format != PIXFORMAT_JPEG) {
    Serial.println("Capture request failure: Frame is not JPEG");
    esp_camera_fb_return(fb);
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Frame is not JPEG");
    Serial.printf("CAP_DIAG not_jpeg fb_get_us=%lld\n",
                  (long long)(t_fb_end - t_fb_start));
    return ESP_FAIL;
  }

  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=capture.jpg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

  int64_t t_send_start = esp_timer_get_time();
  res = httpd_resp_send(req, (const char *)fb->buf, fb->len);
  int64_t t_send_end = esp_timer_get_time();

  // Capture length before returning the frame buffer; do not touch fb after this.
  size_t sent_len = fb->len;
  esp_camera_fb_return(fb);

  if (res == ESP_OK) {
    Serial.printf("Capture request success: Sent %d bytes\n", sent_len);
    Serial.printf("CAP_DIAG ok bytes=%u fb_get_us=%lld send_us=%lld res=%d\n",
                  (unsigned)sent_len,
                  (long long)(t_fb_end - t_fb_start),
                  (long long)(t_send_end - t_send_start),
                  (int)res);
  } else {
    Serial.printf("Capture request failure: send failed with error %d\n", res);
    Serial.printf("CAP_DIAG send_fail bytes=%u fb_get_us=%lld send_us=%lld res=%d\n",
                  (unsigned)sent_len,
                  (long long)(t_fb_end - t_fb_start),
                  (long long)(t_send_end - t_send_start),
                  (int)res);
  }

  return res;
}

// Handler for /status
static esp_err_t status_handler(httpd_req_t *req){
  char json_response[256];
  
  int frame_width = 0;
  int frame_height = 0;
  
  sensor_t * s = esp_camera_sensor_get();
  if (s != NULL) {
    // Determine dimensions based on framesize
    switch(s->status.framesize) {
      case FRAMESIZE_VGA: frame_width = 640; frame_height = 480; break;
      case FRAMESIZE_SVGA: frame_width = 800; frame_height = 600; break;
      case FRAMESIZE_XGA: frame_width = 1024; frame_height = 768; break;
      case FRAMESIZE_UXGA: frame_width = 1600; frame_height = 1200; break;
      default: frame_width = 800; frame_height = 600; break; // fallback estimate
    }
  }

  uint32_t free_heap = ESP.getFreeHeap();
  uint32_t uptime_s = millis() / 1000;

  snprintf(json_response, sizeof(json_response), 
    "{\"camera_initialized\":%s, \"wifi_connected\":%s, \"ip_address\":\"%s\", \"frame_width\":%d, \"frame_height\":%d, \"free_heap\":%u, \"uptime_s\":%u}",
    camera_is_initialized ? "true" : "false",
    wifi_is_connected ? "true" : "false",
    WiFi.localIP().toString().c_str(),
    frame_width,
    frame_height,
    free_heap,
    uptime_s
  );

  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, json_response, strlen(json_response));
}

// Handler for /camera-config
static esp_err_t config_handler(httpd_req_t *req){
  char json_response[512];
  
  sensor_t * s = esp_camera_sensor_get();
  if (s == NULL) {
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }

  snprintf(json_response, sizeof(json_response), 
    "{\"resolution\":\"VGA(640x480)\", \"quality\":%d, \"brightness\":%d, \"contrast\":%d, \"saturation\":%d, \"sharpness\":%d, \"whitebal\":%d, \"auto_exposure\":%d, \"auto_gain\":%d, \"night_mode\":%d, \"lens_correction\":%d}",
    s->status.quality,
    s->status.brightness,
    s->status.contrast,
    s->status.saturation,
    s->status.sharpness,
    s->status.awb,
    s->status.aec,
    s->status.agc,
    s->status.aec2,
    s->status.lenc
  );

  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, json_response, strlen(json_response));
}

void startCameraServer(){
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;

  httpd_uri_t capture_uri = {
    .uri       = "/capture",
    .method    = HTTP_GET,
    .handler   = capture_handler,
    .user_ctx  = NULL
  };

  httpd_uri_t status_uri = {
    .uri       = "/status",
    .method    = HTTP_GET,
    .handler   = status_handler,
    .user_ctx  = NULL
  };
  
  httpd_uri_t config_uri = {
    .uri       = "/camera-config",
    .method    = HTTP_GET,
    .handler   = config_handler,
    .user_ctx  = NULL
  };
  
  if (httpd_start(&camera_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(camera_httpd, &capture_uri);
    httpd_register_uri_handler(camera_httpd, &status_uri);
    httpd_register_uri_handler(camera_httpd, &config_uri);
    Serial.println("HTTP server started");
  } else {
    Serial.println("Error starting HTTP server");
  }
}

// ===========================
// Main Setup and Loop
// ===========================
void setup() {
  Serial.begin(115200);
  Serial.println();
  Serial.println("Booting Smart Shopping Cart - ESP32-CAM...");

  initCamera();
  initWiFi();
  
  if (wifi_is_connected) {
    startCameraServer();
  } else {
    Serial.println("Skipping HTTP server start because WiFi is not connected.");
  }
}

void loop() {
  // Nothing to do here, HTTP server is handled asynchronously
  delay(10000);
}
