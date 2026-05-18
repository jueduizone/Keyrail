#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((error) => {
  const code = error.code ? `${error.code}: ` : "";
  console.error(`keyrail: ${code}${error.message}`);
  if (error.details && Object.keys(error.details).length > 0) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exitCode = 1;
});
