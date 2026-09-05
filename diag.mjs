import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';

const env = readFileSync('.env', 'utf8');
const uri = (env.match(/^MONGO(?:DB)?_URI\s*=\s*(.+)$/m) || [])[1]?.trim();
if (!uri) { console.log('No MONGO_URI in .env'); process.exit(1); }
console.log('uri host:', uri.replace(/\/\/[^@]*@/, '//***@').slice(0, 70));

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 6000 });
await client.connect();
const db = client.db();
console.log('database:', db.databaseName);
console.log('collections:', (await db.listCollections().toArray()).map(c => c.name).join(', '));

const foods = db.collection('foods');
const total = await foods.countDocuments({});
const verified = await foods.countDocuments({ verified: true });
console.log(`\nfoods: ${total} total, ${verified} verified`);

if (total === 0) { console.log('\n>>> THE FOODS COLLECTION IS EMPTY <<<'); await client.close(); process.exit(0); }

console.log('by source:', JSON.stringify(await foods.aggregate([{ $group: { _id: '$source', n: { $sum: 1 } } }]).toArray()));
console.log('indexes:', (await foods.indexes()).map(i => i.name).join(', '));

console.log('\nsamples:');
for (const f of await foods.find({}).limit(5).toArray()) {
  console.log(`  ${f.externalId} | ${f.name} | verified=${f.verified} | terms=${(f.searchTerms||[]).slice(0,10).join(',')}`);
}

console.log('\nqueries:');
for (const q of ['egg', 'eggs', 'dal', 'roti', 'rice', 'poha', 'milk', 'chicken']) {
  let t = 'ERR';
  try { t = await foods.countDocuments({ verified: true, $text: { $search: q } }); }
  catch (e) { t = 'ERR:' + e.message.slice(0, 60); }
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const r = await foods.countDocuments({ verified: true, $or: [{ name: rx }, { searchTerms: rx }] });
  console.log(`  "${q}": $text=${t}  regex=${r}`);
}
await client.close();
