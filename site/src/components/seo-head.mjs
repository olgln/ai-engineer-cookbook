// Extra <head> tags for search engines and link previews, added to Starlight's own (title,
// description, canonical, og:title, og:description). Pure, so it is tested without a build
// (tests/seo-head.test.mjs).
import { OG_IMAGE } from '../config/app.mjs';

const meta = (attrs) => ({ tag: 'meta', attrs });

/**
 * Starlight `head` entries: the preview image (needs the public address, since og:image must be an
 * absolute URL) and the search-console ownership tokens that are set.
 * @param {{ site?: string, imageAlt: string, googleSiteVerification?: string, yandexVerification?: string }} options
 */
export function seoHead({ site, imageAlt, googleSiteVerification, yandexVerification }) {
  const head = [];
  if (site) {
    const image = new URL(OG_IMAGE.path, site).href;
    head.push(
      meta({ property: 'og:image', content: image }),
      meta({ property: 'og:image:type', content: OG_IMAGE.type }),
      meta({ property: 'og:image:width', content: String(OG_IMAGE.width) }),
      meta({ property: 'og:image:height', content: String(OG_IMAGE.height) }),
      meta({ property: 'og:image:alt', content: imageAlt }),
      meta({ name: 'twitter:image', content: image }),
      meta({ name: 'twitter:image:alt', content: imageAlt }),
    );
  }
  if (googleSiteVerification) head.push(meta({ name: 'google-site-verification', content: googleSiteVerification }));
  if (yandexVerification) head.push(meta({ name: 'yandex-verification', content: yandexVerification }));
  return head;
}
