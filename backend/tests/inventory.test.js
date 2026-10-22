
jest.mock('../db', () => ({
    pool: {
      connect: jest.fn(),
    },
  }));
  
  const { pool } = require('../db');
  const {
    reserveStock,
    releaseReservation,
  } = require('../services/inventory');
  
  describe('inventory services', () => {
    let client;
    let productStock;
    let operations;
    let movements;
    let queries;
    let nextOperationId;
  
    beforeEach(() => {
      jest.clearAllMocks();
  
      productStock = {
        product_id: 'PROD_TEST',
        inventory_qty: 10,
        reserved_qty: 0,
      };
  
      operations = [];
      movements = [];
      queries = [];
      nextOperationId = 1;
  
      client = {
        query: jest.fn(async (sql, params = []) => {
          queries.push({ sql, params });
  
          if (
            sql.includes('BEGIN') ||
            sql.includes('COMMIT') ||
            sql.includes('ROLLBACK')
          ) {
            return { rows: [] };
          }
  
          // Create reservation or release operation.
          if (sql.includes('INSERT INTO inventory_operations')) {
            const isRelease = sql.includes("'release'");
            const operationKey = params[0];
  
            if (operations.some(op => op.operation_key === operationKey)) {
              return { rows: [] };
            }
  
            const operation = {
              id: nextOperationId++,
              operation_key: operationKey,
              operation_type: isRelease ? 'release' : 'reservation',
              status: 'pending',
              session_id: isRelease ? null : (params[1] ?? null),
              reservation_operation_id: isRelease ? params[1] : null,
            };
  
            operations.push(operation);
  
            return {
              rows: [{
                id: operation.id,
                operation_type: operation.operation_type,
                status: operation.status,
              }],
            };
          }
  
          // Find the original reservation.
          if (
            sql.includes('FROM inventory_operations io') &&
            sql.includes('io.operation_key = $1')
          ) {
            const operation = operations.find(
              op =>
                op.operation_key === params[0] &&
                op.operation_type === 'reservation' &&
                op.status === 'completed'
            );
  
            if (!operation) return { rows: [] };
  
            const movement = movements.find(
              m =>
                m.operation_id === operation.id &&
                m.product_id === params[1] &&
                m.movement_type === 'reservation'
            );
  
            return movement
              ? {
                  rows: [{
                    id: operation.id,
                    status: operation.status,
                    quantity: movement.quantity,
                  }],
                }
              : { rows: [] };
          }
  
          // Check completed release totals for a reservation.
          if (sql.includes('SUM(im.quantity)')) {
            const reservationId = params[0];
            const productId = params[1];
  
            const releasedQuantity = movements
              .filter(m => {
                const op = operations.find(
                  candidate => candidate.id === m.operation_id
                );
  
                return (
                  op &&
                  op.operation_type === 'release' &&
                  op.status === 'completed' &&
                  op.reservation_operation_id === reservationId &&
                  m.product_id === productId &&
                  m.movement_type === 'release'
                );
              })
              .reduce((sum, m) => sum + m.quantity, 0);
  
            return {
              rows: [{ released_quantity: String(releasedQuantity) }],
            };
          }
  
          // Find an existing operation by its unique key.
          if (
            sql.includes('FROM inventory_operations') &&
            sql.includes('WHERE operation_key = $1')
          ) {
            const operation = operations.find(
              op => op.operation_key === params[0]
            );
  
            return {
              rows: operation
                ? [{
                    id: operation.id,
                    operation_type: operation.operation_type,
                    status: operation.status,
                    session_id: operation.session_id,
                    reservation_operation_id:
                      operation.reservation_operation_id,
                  }]
                : [],
            };
          }
  
          // Find an existing movement for an operation and product.
          if (sql.includes('FROM inventory_movements')) {
            return {
              rows: movements
                .filter(
                  m =>
                    m.operation_id === params[0] &&
                    m.product_id === params[1] &&
                    (
                      !sql.includes("movement_type = 'release'") ||
                      m.movement_type === 'release'
                    )
                )
                .map(m => ({ quantity: m.quantity, product_id: m.product_id })),
            };
          }
  
          // Lock/read product stock.
          if (
            sql.includes('FROM products') &&
            sql.includes('FOR UPDATE')
          ) {
            return productStock &&
              productStock.product_id === params[0]
              ? { rows: [{ ...productStock }] }
              : { rows: [] };
          }
  
          // Update reserved quantity, handling reserve and release separately.
          if (sql.includes('UPDATE products')) {
            if (!productStock || productStock.product_id !== params[1]) {
              return { rows: [], rowCount: 0 };
            }
  
            if (sql.includes('reserved_qty = reserved_qty -')) {
              productStock.reserved_qty -= params[0];
            } else {
              productStock.reserved_qty += params[0];
            }
  
            return { rows: [], rowCount: 1 };
          }
  
          // Record a stock movement.
          if (sql.includes('INSERT INTO inventory_movements')) {
            const operation = operations.find(
              op => op.id === params[0]
            );
  
            const movementType = operation?.operation_type === 'release'
              ? 'release'
              : 'reservation';
  
            movements.push({
              operation_id: params[0],
              product_id: params[1],
              quantity: params[2],
              movement_type: movementType,
              physical_delta: params[3] ?? 0,
              reserved_delta: movementType === 'release'
                ? params[3]
                : params[2],
            });
  
            return { rows: [], rowCount: 1 };
          }
  
          // Mark an operation complete.
          if (sql.includes('UPDATE inventory_operations')) {
            const operation = operations.find(
              op => op.id === params[0]
            );
  
            if (operation) operation.status = 'completed';
  
            return { rows: [], rowCount: operation ? 1 : 0 };
          }
  
          return { rows: [], rowCount: 0 };
        }),
  
        release: jest.fn(),
      };
  
      pool.connect.mockResolvedValue(client);
    });
  
    describe('reserveStock', () => {
      test('reserves available stock once', async () => {
        const result = await reserveStock({
          operationKey: 'reserve-test-1',
          sessionId: 'SESS_TEST',
          productId: 'PROD_TEST',
          quantity: 3,
        });
  
        expect(result.duplicate).toBe(false);
        expect(productStock.reserved_qty).toBe(3);
        expect(movements).toHaveLength(1);
        expect(client.query).toHaveBeenCalledWith('COMMIT');
        expect(client.release).toHaveBeenCalledTimes(1);
      });
  
      test('rejects a reservation larger than available stock', async () => {
        await expect(
          reserveStock({
            operationKey: 'reserve-test-2',
            sessionId: 'SESS_TEST',
            productId: 'PROD_TEST',
            quantity: 11,
          })
        ).rejects.toThrow('Insufficient stock');
  
        expect(productStock.reserved_qty).toBe(0);
        expect(movements).toHaveLength(0);
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      });
  
      test('rejects zero quantity before connecting', async () => {
        await expect(
          reserveStock({
            operationKey: 'reserve-test-3',
            sessionId: 'SESS_TEST',
            productId: 'PROD_TEST',
            quantity: 0,
          })
        ).rejects.toThrow('Invalid reservation parameters');
  
        expect(pool.connect).not.toHaveBeenCalled();
      });
  
      test('does not reserve twice for a completed duplicate operation', async () => {
        const original = await reserveStock({
          operationKey: 'reserve-test-4',
          sessionId: 'SESS_TEST',
          productId: 'PROD_TEST',
          quantity: 3,
        });
  
        expect(original.duplicate).toBe(false);
  
        const result = await reserveStock({
          operationKey: 'reserve-test-4',
          sessionId: 'SESS_TEST',
          productId: 'PROD_TEST',
          quantity: 3,
        });
  
        expect(result.duplicate).toBe(true);
        expect(productStock.reserved_qty).toBe(3);
        expect(movements).toHaveLength(1);
        expect(
          queries.filter(q => q.sql.includes('UPDATE products'))
        ).toHaveLength(1);
      });
  
      test('rejects reuse of an operation key for a different product', async () => {
        await reserveStock({
          operationKey: 'reserve-test-5',
          sessionId: 'SESS_TEST',
          productId: 'PROD_TEST',
          quantity: 3,
        });
  
        await expect(
          reserveStock({
            operationKey: 'reserve-test-5',
            sessionId: 'SESS_TEST',
            productId: 'PROD_OTHER',
            quantity: 3,
          })
        ).rejects.toThrow(
          'Existing reservation operation is incomplete or conflicts with this request'
        );
      });
  
      test('rolls back and releases the client when a database query fails', async () => {
        client.query.mockImplementation(async sql => {
          if (sql === 'BEGIN') return { rows: [] };
  
          if (sql.includes('INSERT INTO inventory_operations')) {
            throw new Error('Simulated database failure');
          }
  
          if (sql === 'ROLLBACK') return { rows: [] };
  
          return { rows: [], rowCount: 0 };
        });
  
        await expect(
          reserveStock({
            operationKey: 'reserve-test-db-error',
            sessionId: 'SESS_TEST',
            productId: 'PROD_TEST',
            quantity: 2,
          })
        ).rejects.toThrow('Simulated database failure');
  
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
        expect(client.release).toHaveBeenCalledTimes(1);
      });
    });
  
    describe('releaseReservation', () => {
      async function createReservation(quantity = 3) {
        return reserveStock({
          operationKey: 'reserve-for-release',
          sessionId: 'SESS_TEST',
          productId: 'PROD_TEST',
          quantity,
        });
      }
  
      test('releases reserved stock successfully', async () => {
        await createReservation(3);
  
        const result = await releaseReservation({
          operationKey: 'release-test-1',
          reservationOperationKey: 'reserve-for-release',
          productId: 'PROD_TEST',
          quantity: 2,
        });
  
        expect(result.duplicate).toBe(false);
        expect(productStock.reserved_qty).toBe(1);
  
        const releaseOperation = operations.find(
          op => op.operation_key === 'release-test-1'
        );
  
        expect(releaseOperation.reservation_operation_id).toBe(1);
        expect(releaseOperation.status).toBe('completed');
      });
  
      test('does not release stock twice for the same operation key', async () => {
        await createReservation(3);
  
        const args = {
          operationKey: 'release-test-2',
          reservationOperationKey: 'reserve-for-release',
          productId: 'PROD_TEST',
          quantity: 2,
        };
  
        const first = await releaseReservation(args);
        const second = await releaseReservation(args);
  
        expect(first.duplicate).toBe(false);
        expect(second.duplicate).toBe(true);
        expect(productStock.reserved_qty).toBe(1);
        expect(movements.filter(m => m.movement_type === 'release'))
          .toHaveLength(1);
      });
  
      test('rejects a release exceeding the original reservation', async () => {
        await createReservation(3);
  
        await expect(
          releaseReservation({
            operationKey: 'release-test-3',
            reservationOperationKey: 'reserve-for-release',
            productId: 'PROD_TEST',
            quantity: 4,
          })
        ).rejects.toThrow(
          'Cumulative release quantity exceeds original reservation'
        );
  
        expect(productStock.reserved_qty).toBe(3);
        expect(movements.filter(m => m.movement_type === 'release'))
          .toHaveLength(0);
      });
  
      test('rejects partial releases that cumulatively exceed the reservation', async () => {
        await createReservation(3);
  
        await releaseReservation({
          operationKey: 'release-test-4a',
          reservationOperationKey: 'reserve-for-release',
          productId: 'PROD_TEST',
          quantity: 2,
        });
  
        await expect(
          releaseReservation({
            operationKey: 'release-test-4b',
            reservationOperationKey: 'reserve-for-release',
            productId: 'PROD_TEST',
            quantity: 2,
          })
        ).rejects.toThrow(
          'Cumulative release quantity exceeds original reservation'
        );
  
        expect(productStock.reserved_qty).toBe(1);
        expect(movements.filter(m => m.movement_type === 'release'))
          .toHaveLength(1);
      });
    });
  });
  