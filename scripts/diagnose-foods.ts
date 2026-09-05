import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { Food } from '../src/models/food.model.js';

async function main() {
  await mongoose.connect(env.mongoUri);
  const db = mongoose.connection.db!;
  console.log('database:', db.databaseName);

  const total = await Food.countDocuments({});
  const verified = await Food.countDocuments({ verified: true });
  const recipes = await Food.countDocuments({ isRecipe: true });
  console.log(`foods: ${total} total, ${verified} verified, ${recipes} recipes`);

  const bySource = await Food.aggregate([
    { $group: { _id: '$source', n: { $sum: 1 } } },
  ]);
  console.log('by source:', JSON.stringify(bySource));

  const idx = await db.collection('foods').indexes();
  console.log('indexes:', idx.map((i) => i.name).join(', '));

  const sample = await Food.find({}).limit(5);
  for (const f of sample) {
    console.log(`  ${f.externalId} | ${f.name} | verified=${f.verified} | terms=${f.searchTerms.slice(0, 8).join(',')}`);
  }

  for (const q of ['egg', 'eggs', 'dal', 'roti', 'rice', 'poha', 'milk']) {
    let textHits = 0;
    try {
      textHits = await Food.countDocuments({ verified: true, $text: { $search: q } });
    } catch (e) {
      textHits = -1;
      console.log(`  $text failed for "${q}":`, (e as Error).message.slice(0, 120));
    }
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const regexHits = await Food.countDocuments({
      verified: true,
      $or: [{ name: rx }, { searchTerms: rx }],
    });
    console.log(`  "${q}": $text=${textHits}  regex=${regexHits}`);
  }

  await mongoose.disconnect();
}
main().catch((e) => { console.error('DIAGNOSE FAILED:', e.message); process.exit(1); });
