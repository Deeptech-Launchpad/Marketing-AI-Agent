import { disconnectSeed, seedPrompts } from './seed.js'

// PROMPTS ONLY. Inserts the prompts a deploy added and touches nothing else —
// no tenant, no member, no existing prompt (see seedPrompts in seed.ts).

seedPrompts()
  .then(() => disconnectSeed())
  .catch(async (err) => {
    console.error(err)
    await disconnectSeed()
    process.exit(1)
  })
