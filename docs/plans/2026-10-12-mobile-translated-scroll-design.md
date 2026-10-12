# Translated mobile scrolling

Full-chapter translation doubles the text retained by the reader. Loaded chapters stay mounted for source selection, listening, notes and logical progress. Measuring every source block during scrolling can also force distant text to render.

## Rendering architecture

Group 48 source rows per text chunk. On supported browsers below the desktop margin-note breakpoint, measure actual chunk heights, then use `content-visibility: auto` and those intrinsic heights to skip distant rendering. All source and translated text remains in the DOM. A 1,600-row fixture has 34 rendering boundaries.

Chunks containing notes or figures keep ordinary layout because their content can change independently. Focused chunks also keep ordinary painting so focus outlines and keyboard hints are visible. Desktop, Pages and unsupported browsers use `display: contents` wrappers, preserving existing row/float behavior.

Invalidate measured heights after translation, source, notes, width, reading typography or font-loading changes. Batch geometry reads before style writes. Preserve the visible row when asynchronous font or width changes replace distant placeholders. Release placeholders before synchronous logical-line preservation for font-size and layout settings.

## Reading position

Search chapter bounds, then chunk bounds, then source rows only inside the current chunk. Do not probe distant source geometry on the normal scroll path. Preserve the next source anchor through figure-only chunks and trailing figures.

Share one exact character measurement between percentage and saved place. Cache cumulative immutable source lengths for the mounted chapter. When the source paragraph is wholly above the eye line while its translation is being read, its exact end offset needs no character-range search. History, progress saves and return paths retain logical source offsets.

## Focused verification

The translated mobile journey covers two loaded 800-paragraph chapters at 390px with 4x CPU throttling. It compares sustained scrolling with containment disabled and enabled in the same browser, reports frame/layout/style/paint metrics, and checks that most distant chunks skip rendering. It also covers source selection across the 48-row boundary, translation arrival and toggles, exact resize height, keyboard focus, a source character through text-size changes, and Scroll/Pages switching.

Focused unit regressions cover the geometry budget, source-length caching, chunk-first lookup, source-end progress while reading translations, mixed figure/text progress, measured height lifecycle and source ordering. Existing position and PDF-content browser journeys cover desktop/mobile settings, reloads, figures and source-page selection.

The final fast-scroll sample reported p95 frame intervals of 58ms without containment and 53ms with it. Maximum intervals were 77ms and 84ms, respectively; timings are machine-dependent and do not prove smoothness on every physical phone. Native rendering work is reduced for distant content, but source DOM and mounted chapter data are still retained. Real-book reproduction and production deployment require access to the Arafat profile and DeepRead service configuration.
