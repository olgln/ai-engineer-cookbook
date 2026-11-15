// Adds the progress API to `astro dev`; `npm start` (scripts/serve.mjs) serves the same API.
import { PROGRESS_API_PATH } from '../config/app.mjs';
import { progressHandler } from '../../scripts/serve/progress-handler.mjs';

export default function progressApi() {
  return {
    name: 'progress-api',
    hooks: {
      'astro:server:setup': ({ server }) => {
        server.middlewares.use(PROGRESS_API_PATH, progressHandler());
      },
    },
  };
}
