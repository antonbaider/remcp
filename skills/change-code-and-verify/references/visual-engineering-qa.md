# Visual Engineering & Vision QA

Use vision as a first-class engineering instrument for any software change whose result can be rendered, seen, or interacted with.

## Iron rule

```text
IF THE RESULT CAN BE SEEN, VISUAL VERIFICATION IS REQUIRED.
```

Do not claim a visible task is fixed, polished, responsive, correct, aligned, production-ready, or faithful to a reference until the relevant rendered state has been inspected visually.

A green test suite is not proof of visual correctness.
A clean DOM is not proof of visual correctness.
Correct CSS source is not proof of visual correctness.
A `200 OK` is not proof of visual correctness.

The engineering loop is:

`understand -> inspect baseline -> change -> run -> render -> capture -> SEE -> diagnose -> fix -> recapture -> verify -> report evidence`

The important step is **SEE**. A screenshot is not a decorative artifact added after implementation; it is input to the implementation loop.

## Mandatory triggers

Use this workflow for:

- CSS, layout, spacing, typography, colors and themes;
- icons, images and media;
- responsive and mobile behavior;
- navigation, headers, footers and shells;
- modals, drawers, menus, popovers and tooltips;
- forms, tables, dashboards and charts;
- players and interactive controls;
- animations/transitions when a static state can verify geometry or final state;
- loading, empty, error, success and disabled states;
- focus-visible/accessibility-visible behavior;
- screenshot/Figma/mockup implementation;
- browser-specific regressions;
- auth/onboarding flows;
- backend/API changes that alter rendered state;
- permissions that show, hide, enable or disable controls;
- realtime/WebSocket state surfaced in the UI;
- image/file preview behavior;
- user-reported bugs supplied as screenshots.

When the user supplies a screenshot, inspect it before editing and treat the visible differences as acceptance criteria.

## When a screenshot is not mandatory

A visual loop may be omitted only when there is no meaningful visible surface, for example:

- pure database migration with no affected UI;
- isolated algorithm/library change;
- non-rendered CLI behavior;
- backend worker behavior with no user-facing status surface;
- infrastructure-only change with no visual acceptance criterion.

When uncertain, prefer visual verification.

## Tool order

Use the strongest available path.

### Real paired ReMCP computer

When a paired computer is the target:

1. resolve the correct device;
2. start or verify the real application;
3. open the affected route/state in the real browser/computer workflow;
4. use `take_screenshot`;
5. return/show the screenshot in chat when supported;
6. inspect the returned image with vision;
7. fix anything still wrong;
8. take and inspect a fresh final screenshot.

If an image already exists on the device, use `read_image` to bring it into the conversation when useful.

Do not merely save a PNG path and say it was checked.

### Browser automation

Use project-native Playwright or equivalent for deterministic:

- route navigation;
- viewport/device emulation;
- auth/state setup;
- interactions;
- console/page-error collection;
- screenshots;
- repeatable multi-route checks;
- screenshot regression tests.

Automated pixel comparison supplements semantic visual review. A screenshot can be consistently wrong.

## Establish the visual contract

Before editing, derive "correct" from this priority order:

1. user-provided screenshot/mockup/Figma;
2. existing nearby product screens;
3. repository component/design system;
4. product design tokens;
5. explicit requirements.

Represent the target internally as:

`route -> state -> action -> expected visible result -> viewports`

Example:

`/app/agents -> mobile -> open agent menu -> drawer fits safe area, CTA remains visible, correct icons, no horizontal overflow`

## Baseline first

For a visible bug:

1. open the real route;
2. reproduce the state;
3. capture a screenshot;
4. inspect it;
5. identify the exact visible failure;
6. correlate it with source/DOM/CSS/runtime evidence.

Prefer a before/after pair when feasible.

Typical visual symptoms should become technical hypotheses:

- button clipped at bottom -> fixed height, overflow, safe-area inset, dynamic viewport units;
- icons became emoji -> icon component fallback, missing asset/font, inheritance, serialization;
- modal behind header -> stacking context, portal root, transforms, z-index;
- layout moves after load -> intrinsic size, font/image loading, hydration, async content;
- desktop good/mobile broken -> breakpoint, min-width, wrapping, absolute positioning, safe areas;
- wrong permission UI -> backend authorization response plus client state; never solve by only hiding controls.

Vision tells you **where/how** the product is wrong. Code and runtime evidence tell you **why**.

## Implement narrowly

Make the smallest coherent change that fixes the cause.

Do not turn a targeted visual bug into a broad redesign unless the requested result requires it.

Preserve the existing visual language and unrelated user changes.

## Render the actual result

Validate the real application, not a static approximation.

Confirm:

- correct route;
- correct user/account/tenant fixture;
- correct theme;
- correct viewport;
- correct interaction state;
- no stale bundle;
- no dev error overlay;
- no blank screen.

## Screenshot inspection checklist

### Structure and hierarchy

Inspect:

- correct page and state;
- expected components present;
- missing or duplicate controls;
- primary action hierarchy;
- correct header/footer/navigation placement;
- overlay placement.

### Geometry

Inspect:

- alignment;
- padding and margins;
- gaps;
- widths/heights;
- centering;
- card/button geometry;
- icon alignment;
- baseline alignment;
- line wrapping.

### Clipping and overflow

Inspect:

- horizontal page scroll;
- cropped text/icons;
- clipped shadows;
- CTA outside viewport;
- fixed/sticky elements covering content;
- mobile safe-area failures;
- modal/drawer edges beyond screen;
- bad `100vh`/dynamic viewport behavior.

### Typography

Inspect:

- actual font rendering;
- unexpected fallback fonts;
- weight;
- size;
- line height;
- letter spacing;
- truncation and ellipsis;
- wrapping;
- readable contrast.

### Icons and imagery

Inspect:

- expected icon, not emoji or placeholder;
- correct source;
- no missing/broken image;
- aspect ratio;
- crop/fit;
- placeholder behavior;
- light/dark variant if applicable.

### Theme and color

Inspect:

- light/dark consistency;
- surfaces;
- borders;
- text contrast;
- selected/hover/focus state;
- disabled state;
- accidental old accent colors;
- transparent/opaque layers.

### Interactions and states

Inspect relevant:

- hover;
- focus;
- active;
- selected;
- disabled;
- open;
- loading;
- empty;
- validation error;
- backend error;
- success;
- completed state.

### Semantic visible correctness

Vision must also catch:

- wrong label;
- wrong count;
- stale value;
- duplicated item;
- wrong button text;
- wrong status/plan badge;
- unexpected demo/placeholder content;
- bad localization;
- broken date/number formatting.

Visual QA is not only CSS QA.

## Required viewport coverage

Use the real support matrix when available.

Otherwise use this minimum:

| Change | Minimum visual verification |
|---|---|
| Desktop-only component | representative desktop + affected state |
| Mobile-only bug | target phone/device + affected state |
| Responsive shared component | desktop + mobile + intermediate width when risky |
| Shell/nav/theme | desktop + mobile on key affected route(s) |
| Modal/drawer/menu | closed + open state |
| Form flow | initial + validation/error + next/success |
| Auth/onboarding | key steps + relevant error/completed state |
| Data view | changed loading/empty/success/error states |

Coverage follows risk.

## Runtime evidence

For browser tasks, pair visual inspection with runtime evidence when relevant.

Check:

- uncaught exceptions;
- React/Next hydration errors;
- failed resources;
- 4xx/5xx requests;
- CORS/CSP failures;
- failed fonts/icons/images;
- duplicate requests when relevant;
- WebSocket/realtime failures;
- warnings directly related to the changed flow.

Do not accept a visually correct screenshot while the changed flow is throwing relevant errors.

## Screenshot capture rules

### Capture useful evidence

Use:

- viewport screenshot for local layout/interaction state;
- full-page screenshot for long composition review;
- component/region screenshot when supported and context is still clear.

Do not crop away the evidence needed to understand the result.

### Freshness

Final screenshots must be captured after the final relevant code change and from the runtime/build being claimed.

Never reuse an earlier screenshot as final proof.

### Show it

When the tool can return the image in chat, show it when the user asked to see/check screenshots or when it materially demonstrates completion.

A filesystem path alone is not equivalent to visual evidence.

### Protect sensitive data

Never expose in screenshots:

- passwords;
- API keys;
- session/auth tokens;
- cookies;
- recovery codes;
- private environment variables;
- secrets in terminals/devtools;
- unnecessary private customer data.

Use safe fixtures or crop/redact when needed. Do not weaken security controls for capture convenience.

## Automated screenshot regression

Add/update screenshot tests when the visual contract is important and stable enough.

Good candidates:

- critical repeated regressions;
- design-system components;
- stable desktop/mobile layouts;
- stateful drawers/modals;
- product shell/navigation.

Rules:

- stabilize fonts/data/animations/time where necessary;
- do not blindly approve large diffs;
- inspect changed images before accepting a baseline;
- keep semantic visual review.

Pixel-diff tools cannot tell you that the wrong button is rendered perfectly.

## Vibe-coding workflow

Do not use:

`prompt -> large code edit -> build -> declare success`

Use:

`prompt -> inspect current product -> small coherent edit -> run -> screenshot -> see -> adjust -> screenshot -> functional checks -> final screenshot`

For a multi-section page, verify section-by-section when it reduces rework, then verify the full composition.

## Definition of Done for visible work

A visible task is not done until all relevant statements are true:

- [ ] real target route opened;
- [ ] intended state reproduced/exercised;
- [ ] no relevant fatal overlay or blank screen;
- [ ] fresh final screenshot captured;
- [ ] screenshot actually inspected with vision;
- [ ] desktop inspected when applicable;
- [ ] mobile inspected when applicable;
- [ ] relevant interaction states inspected;
- [ ] no obvious clipping/overflow/misalignment remains;
- [ ] typography/icons/images/theme correct;
- [ ] visible content semantically correct;
- [ ] console/network/runtime checked when relevant;
- [ ] tests/typecheck/build passed as required;
- [ ] screenshot shown/returned when requested or useful;
- [ ] any unverified visual surface explicitly reported.

## Blocker policy

If valid rendered screenshots cannot be obtained because the device is offline, browser cannot open, authentication is unavailable, or the app does not start:

- report the exact blocker;
- continue non-visual verification where useful;
- do not claim visual correctness;
- never fabricate an unseen result.

## Reporting

For visible engineering work, report both:

### Visual verification

Example:

```text
PASS /app/settings — desktop 1440px — default + dropdown open
PASS /app/settings — mobile — default + dropdown open
PASS no horizontal overflow, clipped CTA, icon fallback, or broken theme observed
```

### Functional verification

List actual test/typecheck/build/API/runtime checks and outcomes.

### Remaining risk

Only real gaps such as an untested browser/device/state.

## Anti-patterns

Never:

- claim UI correctness from source inspection alone;
- take a screenshot without inspecting it;
- hide screenshots when the user explicitly asked to see them;
- inspect only desktop for a mobile/responsive task;
- inspect one static state for an interaction bug;
- accept snapshot updates without review;
- use screenshots instead of functional/security tests;
- hide authorization failures only in the frontend;
- fake success/data only to make screenshots look good;
- ignore relevant browser/runtime errors because the page looks okay;
- reuse stale screenshots;
- expose secrets in screenshots;
- declare completion while the screenshot still shows a defect.

## Default ReMCP engineering standard

When ReMCP can capture the real screen, the standard is no longer:

> I changed the code and the tests passed.

The standard is:

> I changed the code, ran the real target environment, captured the affected state, inspected what the user would actually see, corrected remaining visible defects, and verified the final implementation with both visual and functional evidence.
