// Adds /api/progress to `astro dev`; `npm start` (scripts/serve.mjs) serves the same API.
import { progressHandler } from './progress-handler.mjs';

export default function progressApi() {
  return {
    name: 'progress-api',
    hooks: {
      'astro:server:setup': ({ server }) => {
        server.middlewares.use('/api/progress', progressHandler());
      },
    },
  };
}
