// Runs the MongoDB commands shown in the project report and prints each command with its result.
// Usage: npx tsx scripts/report-mongo.ts      (creates and deletes one temporary document, worker_id 9001)
import './_env';
import { mongoDb, closeMongo } from '../src/lib/mongo';

const fmt = (r: unknown): string => {
  if (typeof r === 'string') return r;
  const one = JSON.stringify(r);
  if (one.length <= 100) return one;
  if (Array.isArray(r)) return '[\n' + r.map((x) => '  ' + JSON.stringify(x)).join(',\n') + '\n]';
  return JSON.stringify(r, null, 2);
};
const show = (title: string, cmd: string, result: unknown) => console.log(`\n// ${title}\n> ${cmd}\n${fmt(result)}`);

async function main() {
  const db = await mongoDb();
  const col = db.collection('worker_portfolio');

  const info = (await db.listCollections({ name: 'worker_portfolio' }).toArray())[0] as any;
  show('M1. Collection with a $jsonSchema validator (only the shared fields are enforced)',
    'db.getCollectionInfos({ name: "worker_portfolio" })[0].options',
    { validationLevel: info.options.validationLevel, validationAction: info.options.validationAction,
      required: info.options.validator.$jsonSchema.required, properties: Object.keys(info.options.validator.$jsonSchema.properties) });
  show('M2. Indexes', 'db.worker_portfolio.getIndexes()', (await col.indexes()).map((i: any) => ({ name: i.name, key: i.key, unique: !!i.unique })));

  // ---- CREATE
  const doc = {
    worker_id: 9001, trade: 'Locksmith',
    photos: [{ url: '/uploads/9001/door-lock.jpg', caption: 'Mortise lock replacement' }],
    certifications: [{ name: 'Certified Locksmith', issuer: 'Karnataka Locksmith Association', issued_year: 2021 }],
    trade_attributes: { skills: ['door lock repair', 'key duplication'], emergency_service: true, brands: ['Godrej', 'Yale'] },
    updated_at: new Date(),
  };
  await col.deleteMany({ worker_id: 9001 });
  const ins = await col.insertOne(doc as any);
  show('M3. CREATE - insert a document whose trade_attributes differ from every other trade',
    'db.worker_portfolio.insertOne({ worker_id: 9001, trade: "Locksmith", photos: [...], certifications: [...], trade_attributes: { skills: [...], emergency_service: true, brands: [...] }, updated_at: new Date() })',
    { acknowledged: ins.acknowledged, insertedId: String(ins.insertedId) });

  // ---- READ
  show('M4. READ - one worker\'s portfolio',
    'db.worker_portfolio.findOne({ worker_id: 1 }, { _id: 0, photos: 0, updated_at: 0 })',
    await col.findOne({ worker_id: 1 }, { projection: { _id: 0, photos: 0, updated_at: 0 } }));
  show('M5. READ - query inside the free-form part (array element match on trade_attributes.skills)',
    'db.worker_portfolio.find({ "trade_attributes.skills": "inverter installation" }, { _id: 0, worker_id: 1, trade: 1 })',
    await col.find({ 'trade_attributes.skills': 'inverter installation' }, { projection: { _id: 0, worker_id: 1, trade: 1 } }).toArray());
  show('M6. READ - aggregation: workers and certifications per trade',
    'db.worker_portfolio.aggregate([{ $group: { _id: "$trade", workers: { $sum: 1 }, certifications: { $sum: { $size: "$certifications" } } } }, { $sort: { workers: -1, _id: 1 } }])',
    await col.aggregate([{ $group: { _id: '$trade', workers: { $sum: 1 }, certifications: { $sum: { $size: '$certifications' } } } }, { $sort: { workers: -1, _id: 1 } }]).toArray());

  // ---- UPDATE
  const upd = await col.updateOne({ worker_id: 9001 },
    { $set: { 'trade_attributes.emergency_service': false, updated_at: new Date() },
      $push: { photos: { url: '/uploads/9001/safe-lock.jpg', caption: 'Safe lock service' } as any },
      $addToSet: { 'trade_attributes.skills': 'safe lock service' } as any });
  show('M7. UPDATE - $set a field, $push a photo, $addToSet a skill',
    'db.worker_portfolio.updateOne({ worker_id: 9001 }, { $set: { "trade_attributes.emergency_service": false, updated_at: new Date() }, $push: { photos: {...} }, $addToSet: { "trade_attributes.skills": "safe lock service" } })',
    { matchedCount: upd.matchedCount, modifiedCount: upd.modifiedCount });
  const after = await col.findOne({ worker_id: 9001 }, { projection: { _id: 0, worker_id: 1, 'trade_attributes': 1, photos: 1 } });
  show('M8. READ back the updated document', 'db.worker_portfolio.findOne({ worker_id: 9001 }, { _id: 0, worker_id: 1, trade_attributes: 1, photos: 1 })', after);

  // ---- validator
  try { await col.insertOne({ worker_id: 9002, photos: [], certifications: [], trade_attributes: {}, updated_at: new Date() } as any); }
  catch (e: any) { show('M9. VALIDATION - a document without "trade" is rejected by the database',
    'db.worker_portfolio.insertOne({ worker_id: 9002, photos: [], certifications: [], trade_attributes: {}, updated_at: new Date() })', `MongoServerError code ${e.code}: ${e.message}`); }
  try { await col.insertOne({ ...doc, _id: undefined } as any); }
  catch (e: any) { show('M10. UNIQUE INDEX - a second portfolio for the same worker is rejected',
    'db.worker_portfolio.insertOne({ worker_id: 9001, ... })', `MongoServerError code ${e.code}: ${String(e.message).slice(0, 110)}`); }

  // ---- DELETE
  const del = await col.deleteOne({ worker_id: 9001 });
  show('M11. DELETE - remove the temporary document', 'db.worker_portfolio.deleteOne({ worker_id: 9001 })', { acknowledged: del.acknowledged, deletedCount: del.deletedCount });
  show('M12. Collection count is back to the seeded 40', 'db.worker_portfolio.countDocuments()', await col.countDocuments());
  await closeMongo();
}
main().catch((e) => { console.error(e); process.exit(1); });
