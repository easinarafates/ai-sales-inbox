// Vercel Serverless Function entry for the Express API.
//
// Vercel builds the app first (npm run build → dist/) and wraps this
// default export as one function that serves every /api/* path (see
// vercel.json rewrites). Locally this file is never used — `npm start`
// runs `node dist/index.js` directly, and `npm run dev` runs tsx on
// src/index.ts.
import app from '../dist/index.js';

export default app;
