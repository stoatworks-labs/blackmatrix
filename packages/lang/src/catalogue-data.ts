/**
 * The generated catalogue, loaded once.
 *
 * Its own module so that `index.ts` can export a curated public surface while
 * the internals import the data directly, without either importing the other.
 */

import generated from './catalogue.generated.json' with { type: 'json' }
import type { Catalogue } from './catalogue.js'

export const CATALOGUE = generated as unknown as Catalogue
