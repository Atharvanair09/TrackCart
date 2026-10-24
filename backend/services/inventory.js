const { pool } = require('../db');

/**
 * Reserve stock for an inventory operation.
 *
 * inventory_qty = physical stock on hand
 * reserved_qty  = stock allocated to active reservations
 * available     = inventory_qty - reserved_qty
 *
 * The caller must supply a stable operationKey and a productId.
 */
async function reserveStock({
  operationKey,
  sessionId,
  productId,
  quantity,
}) {
  if (
    typeof operationKey !== 'string' ||
    !operationKey.trim() ||
    typeof productId !== 'string' ||
    !productId.trim() ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0
  ) {
    throw new Error('Invalid reservation parameters');
  }

  if (
    sessionId !== undefined &&
    sessionId !== null &&
    (typeof sessionId !== 'string' || !sessionId.trim())
  ) {
    throw new Error('Invalid sessionId');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Claim the operation key first. Concurrent retries serialize here.
    const operationResult = await client.query(
      `INSERT INTO inventory_operations
         (operation_type, operation_key, session_id, status)
       VALUES ('reservation', $1, $2, 'pending')
       ON CONFLICT (operation_key) DO NOTHING
       RETURNING id, operation_type, status`,
      [operationKey, sessionId ?? null]
    );

    if (operationResult.rows.length === 0) {
      const existingResult = await client.query(
        `SELECT id, operation_type, status, session_id
         FROM inventory_operations
         WHERE operation_key = $1
         FOR UPDATE`,
        [operationKey]
      );

      const existing = existingResult.rows[0];

      if (
        !existing ||
        existing.operation_type !== 'reservation' ||
        existing.session_id !== (sessionId ?? null)
      ) {
        throw new Error('Operation key already used for a different operation');
      }

      const movementResult = await client.query(
        `SELECT product_id, quantity
         FROM inventory_movements
         WHERE operation_id = $1 AND product_id = $2`,
        [existing.id, productId]
      );

      if (
        existing.status === 'completed' &&
        movementResult.rows.length === 1 &&
        Number(movementResult.rows[0].quantity) === quantity
      ) {
        await client.query('COMMIT');
        return {
          operationId: existing.id,
          operationKey,
          productId,
          quantity,
          duplicate: true,
        };
      }

      throw new Error('Existing reservation operation is incomplete or conflicts with this request');
    }

    const operation = operationResult.rows[0];

    // Lock the product row and verify available stock.
    const productResult = await client.query(
      `SELECT product_id, inventory_qty, reserved_qty
       FROM products
       WHERE product_id = $1
       FOR UPDATE`,
      [productId]
    );

    if (productResult.rows.length === 0) {
      throw new Error(`Product not found: ${productId}`);
    }

    const product = productResult.rows[0];
    const physicalStock = Number(product.inventory_qty);
    const reservedStock = Number(product.reserved_qty);
    const availableStock = physicalStock - reservedStock;

    if (
      !Number.isSafeInteger(physicalStock) ||
      !Number.isSafeInteger(reservedStock) ||
      physicalStock < 0 ||
      reservedStock < 0 ||
      quantity > availableStock
    ) {
      throw new Error(`Insufficient stock for product ${productId}`);
    }

    await client.query(
      `UPDATE products
       SET reserved_qty = reserved_qty + $1
       WHERE product_id = $2`,
      [quantity, productId]
    );

    await client.query(
      `INSERT INTO inventory_movements
         (operation_id, product_id, movement_type, quantity,
          physical_delta, reserved_delta)
       VALUES ($1, $2, 'reservation', $3, 0, $3)`,
      [operation.id, productId, quantity]
    );

    await client.query(
      `UPDATE inventory_operations
       SET status = 'completed', completed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [operation.id]
    );

    await client.query('COMMIT');

    return {
      operationId: operation.id,
      operationKey,
      productId,
      quantity,
      duplicate: false,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original operation error.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function releaseReservation({
    operationKey,
    reservationOperationKey,
    productId,
    quantity,
    externalClient,
  }) {
    if (
      typeof operationKey !== 'string' ||
      !operationKey.trim() ||
      typeof reservationOperationKey !== 'string' ||
      !reservationOperationKey.trim() ||
      typeof productId !== 'string' ||
      !productId.trim() ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0
    ) {
      throw new Error('Invalid release parameters');
    }
  
    const client = externalClient || (await pool.connect());
    const isOwner = !externalClient; // true if we created the client
  
    try {
      if (isOwner) {
        await client.query('BEGIN');
      }
  
      // Lock the original reservation first. All releases against this
      // reservation must acquire this lock before checking released quantity.
      const reservationResult = await client.query(
        `SELECT io.id, io.status, im.quantity
         FROM inventory_operations io
         JOIN inventory_movements im
           ON im.operation_id = io.id
         WHERE io.operation_key = $1
           AND io.operation_type = 'reservation'
           AND io.status = 'completed'
           AND im.product_id = $2
         FOR UPDATE OF io`,
        [reservationOperationKey, productId]
      );
  
      if (reservationResult.rows.length !== 1) {
        throw new Error('Completed reservation not found');
      }
  
      const reservation = reservationResult.rows[0];
      const reservationQuantity = Number(reservation.quantity);
  
      if (
        !Number.isSafeInteger(reservationQuantity) ||
        reservationQuantity <= 0
      ) {
        throw new Error('Original reservation quantity is invalid');
      }
  
      // Check whether this release operation has already been completed.
      const existingRelease = await client.query(
        `SELECT id, operation_type, status, reservation_operation_id
         FROM inventory_operations
         WHERE operation_key = $1
         FOR UPDATE`,
        [operationKey]
      );
  
      if (existingRelease.rows.length > 0) {
        const release = existingRelease.rows[0];
  
        if (
          release.operation_type !== 'release' ||
          release.status !== 'completed' ||
          Number(release.reservation_operation_id) !==
            Number(reservation.id)
        ) {
          throw new Error(
            'Release operation key already used or conflicts with this request'
          );
        }
  
        const priorMovement = await client.query(
          `SELECT quantity
           FROM inventory_movements
           WHERE operation_id = $1
             AND product_id = $2
             AND movement_type = 'release'`,
          [release.id, productId]
        );
  
        if (
          priorMovement.rows.length === 1 &&
          Number(priorMovement.rows[0].quantity) === quantity
        ) {
          if (isOwner) await client.query('COMMIT');
  
          return {
            operationId: release.id,
            duplicate: true,
          };
        }
  
        throw new Error('Release operation conflicts with this request');
      }
  
      // Count all completed releases linked to this reservation.
      const releasedResult = await client.query(
        `SELECT COALESCE(SUM(im.quantity), 0) AS released_quantity
         FROM inventory_operations io
         JOIN inventory_movements im
           ON im.operation_id = io.id
         WHERE io.operation_type = 'release'
           AND io.status = 'completed'
           AND io.reservation_operation_id = $1
           AND im.product_id = $2
           AND im.movement_type = 'release'`,
        [reservation.id, productId]
      );
  
      const alreadyReleased = Number(
        releasedResult.rows[0].released_quantity
      );
  
      if (
        !Number.isSafeInteger(alreadyReleased) ||
        alreadyReleased < 0
      ) {
        throw new Error('Previously released quantity is invalid');
      }
  
      if (alreadyReleased + quantity > reservationQuantity) {
        throw new Error(
          'Cumulative release quantity exceeds original reservation'
        );
      }
  
      // Create the release operation linked to its reservation.
      const releaseInsert = await client.query(
        `INSERT INTO inventory_operations
           (
             operation_type,
             operation_key,
             reservation_operation_id,
             status
           )
         VALUES ('release', $1, $2, 'pending')
         ON CONFLICT (operation_key) DO NOTHING
         RETURNING id`,
        [operationKey, reservation.id]
      );
  
      if (releaseInsert.rows.length !== 1) {
        throw new Error('Release operation key already exists');
      }
  
      // Lock the product and make sure sufficient stock remains reserved.
      const productResult = await client.query(
        `SELECT product_id, reserved_qty
         FROM products
         WHERE product_id = $1
         FOR UPDATE`,
        [productId]
      );
  
      if (
        productResult.rows.length !== 1 ||
        Number(productResult.rows[0].reserved_qty) < quantity
      ) {
        throw new Error('Reserved stock is insufficient for release');
      }
  
      await client.query(
        `UPDATE products
         SET reserved_qty = reserved_qty - $1
         WHERE product_id = $2`,
        [quantity, productId]
      );
  
      await client.query(
        `INSERT INTO inventory_movements
           (
             operation_id,
             product_id,
             movement_type,
             quantity,
             physical_delta,
             reserved_delta
           )
         VALUES ($1, $2, 'release', $3, 0, $4)`,
        [releaseInsert.rows[0].id, productId, quantity, -quantity]
      );
  
      await client.query(
        `UPDATE inventory_operations
         SET status = 'completed',
             completed_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [releaseInsert.rows[0].id]
      );
  
      if (isOwner) await client.query('COMMIT');
  
      return {
        operationId: releaseInsert.rows[0].id,
        duplicate: false,
      };
    } catch (error) {
      try {
        if (isOwner) await client.query('ROLLBACK');
      } catch {
        // Preserve the original error.
      }
  
      throw error;
    } finally {
      if (isOwner) client.release();
    }
}
  
module.exports = {
  reserveStock,
  releaseReservation,
};
