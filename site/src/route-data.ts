// Starlight route middleware (astro.config.mjs `routeMiddleware`): adjusts each page's head to its language.
import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import i18n from './generated/i18n.json';
import { localizedHead } from './head/localized-head.mjs';
import { localeOf } from './locales/locales.mjs';
import { stringsFor } from './locales/strings.mjs';

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const { ogImage, ogLocale } = localeOf(route.lang);
  route.head = localizedHead(route.head, context.url.pathname, i18n.shared, {
    imageAlt: stringsFor(route.lang).site.ogImageAlt,
    image: ogImage,
    ogLocale,
  });
});
