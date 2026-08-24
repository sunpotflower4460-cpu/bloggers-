import { runGarden } from "../lib/engine";

const results = await runGarden(process.argv[2]);
console.log(JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
