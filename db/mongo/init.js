// MongoDB bootstrap - owner: Person B.
// Run by scripts/db-reset.sh:  mongosh "mongodb://localhost:27017/skillmarket" < db/mongo/init.js
//
// One collection, one document per worker. The worker_id is a LOGICAL reference to PostgreSQL
// worker.worker_id (there is no cross-database foreign key - see docs/02-architecture.md section 6).
// Only the fields every trade shares are validated; everything trade-specific lives in
// trade_attributes, which is the whole reason this data is in MongoDB and not in PostgreSQL.

db = db.getSiblingDB('skillmarket');

if (!db.getCollectionNames().includes('worker_portfolio')) {
  db.createCollection('worker_portfolio', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['worker_id', 'trade', 'updated_at'],
        properties: {
          worker_id:  { bsonType: ['int', 'long'], description: 'logical ref to PostgreSQL worker.worker_id' },
          trade:      { bsonType: 'string', minLength: 2 },
          photos: {
            bsonType: 'array',
            items: {
              bsonType: 'object',
              required: ['url'],
              properties: { url: { bsonType: 'string' }, caption: { bsonType: 'string' }, uploaded_at: { bsonType: 'date' } }
            }
          },
          certifications: {
            bsonType: 'array',
            items: {
              bsonType: 'object',
              required: ['name'],
              properties: { name: { bsonType: 'string' }, issuer: { bsonType: 'string' }, number: { bsonType: 'string' }, issued_year: { bsonType: ['int', 'long'] } }
            }
          },
          trade_attributes: { bsonType: 'object', description: 'free-form, differs per trade; skills[] is the one agreed key' },
          updated_at: { bsonType: 'date' }
        }
      }
    },
    validationLevel: 'moderate',
    validationAction: 'error'
  });
}

db.worker_portfolio.createIndex({ worker_id: 1 }, { unique: true });
db.worker_portfolio.createIndex({ trade: 1 });

print('mongo: worker_portfolio ready');
