// A temporary script to inspect DB product groups
import { openDB } from 'idb';

async function run() {
  const db = await openDB('daigou-erp-db', 2);
  const groups = await db.getAll('product_groups');
  console.log('Product Groups count:', groups.length);
  groups.forEach(g => {
    console.log(`ID: ${g.id}, Title: ${g.title}, ListingType: ${g.listing_type}, SourceType: ${g.source_type}`);
  });
}

run();
