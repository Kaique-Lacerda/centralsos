// Static entrypoint: Vercel's standalone dynamic routes inject query parameters.
// Preserve the original URL for native authentication and its strict query checks.
export { handleControlApi as default } from '../server/control/HttpApi.js';
