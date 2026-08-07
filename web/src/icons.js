// Inline SVG icons. Two sources:
//  - `s(...)` — hand-rolled stroke icons (same convention as busybar-emulator)
//    for the handful of glyphs the firmware icon set has no equivalent for.
//  - `f(...)` — lifted straight from the real firmware web UI's icon set
//    (/assets/frontend/assets/icons/bi/*.svg, 24x24 viewBox, fill="currentColor"),
//    width/height stripped so CSS sizes them like every other icon here.
const s = (inner, sw = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
const f = (inner) => `<svg viewBox="0 0 24 24" fill="none">${inner}</svg>`

export const icons = {
  // firmware: settings-fill.svg — used at size-6 (24px) for the Settings tab, per spec.
  settings: f('<path d="M15.5618 3C16.6303 3 17.6189 3.57257 18.1527 4.50146L21.6004 10.5015C22.1331 11.4289 22.1333 12.5712 21.6004 13.4985L18.1527 19.4985C17.619 20.4273 16.6316 20.9998 15.5633 21H8.4475C7.38086 20.9999 6.39543 20.4293 5.861 19.5029L2.40163 13.5073C1.86599 12.5782 1.86625 11.4322 2.40163 10.5029L5.861 4.49854C6.39525 3.57126 7.38164 3 8.44896 3H15.5618ZM9.5 9.5V14.5H14.5V9.5H9.5Z" fill="currentColor"/>'),
  // firmware: settings.svg (outline) — lifted verbatim (filled evenodd, not a
  // stroke) so it matches `i-bi-settings` 1:1. Inactive Settings tab + Library
  // header view-toggle default (inactive) state.
  settingsOutline: f('<path d="M11 11V13H13V11H11ZM15 13C15 14.1046 14.1046 15 13 15H11C9.89543 15 9 14.1046 9 13V11C9 9.89543 9.89543 9 11 9H13C14.1046 9 15 9.89543 15 11V13Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M15.5618 3C16.6303 3 17.6188 3.57306 18.1526 4.50195L21.6008 10.502C22.1333 11.4293 22.1336 12.5718 21.6008 13.499L18.1526 19.499L18.0481 19.668C17.5328 20.4412 16.6877 20.931 15.7629 20.9932L15.5637 21H8.44749C7.381 20.9998 6.39596 20.4292 5.86156 19.5029L2.4016 13.5078C1.86598 12.5788 1.86629 11.4322 2.4016 10.5029L5.86156 4.49902C6.36243 3.62967 7.26042 3.07296 8.25023 3.00684L8.44945 3H15.5618ZM15.5627 19H8.44749C8.09873 18.9998 7.77267 18.8123 7.59398 18.5029L4.135 12.5088C3.95601 12.1983 3.95542 11.8127 4.135 11.501L7.59398 5.49707C7.77248 5.18725 8.09988 5 8.44945 5H15.5618C15.9126 5 16.2412 5.18843 16.4192 5.49805L19.8664 11.498L19.925 11.6172C20.0422 11.903 20.0224 12.2305 19.8664 12.502L16.4192 18.502C16.2411 18.8119 15.913 18.9999 15.5627 19Z" fill="currentColor"/>'),
  // 2×2 grid — Library header view-toggle "Apps" affordance. Outline is the
  // inactive state, `gridFill` the active one.
  grid: s('<rect x="3.75" y="3.75" width="6.5" height="6.5" rx="1.6"/><rect x="13.75" y="3.75" width="6.5" height="6.5" rx="1.6"/><rect x="3.75" y="13.75" width="6.5" height="6.5" rx="1.6"/><rect x="13.75" y="13.75" width="6.5" height="6.5" rx="1.6"/>'),
  gridFill: f('<rect x="3.75" y="3.75" width="6.5" height="6.5" rx="1.6" fill="currentColor"/><rect x="13.75" y="3.75" width="6.5" height="6.5" rx="1.6" fill="currentColor"/><rect x="3.75" y="13.75" width="6.5" height="6.5" rx="1.6" fill="currentColor"/><rect x="13.75" y="13.75" width="6.5" height="6.5" rx="1.6" fill="currentColor"/>'),
  // firmware: cross.svg
  close: f('<path d="M18.3629 7.06746L13.4305 11.9988L18.3648 16.9321L16.9507 18.3471L12.0165 13.4129L7.04919 18.3812L5.63513 16.9661L10.6024 11.9988L5.63651 7.03293L7.05057 5.61887L12.0165 10.5848L16.9488 5.65339L18.3629 7.06746Z" fill="currentColor"/>'),
  // firmware: refresh.svg
  restart: f('<path d="M18.1032 5.36816C19.8956 7.0133 21.0193 9.37535 21.0193 12C21.0193 16.9706 16.9898 21 12.0193 21V23L8.01926 19.9932L12.0193 17V19C15.8853 19 19.0193 15.866 19.0193 12C19.0193 9.8278 18.03 7.88648 16.4773 6.60254L18.1032 5.36816ZM15.9812 4.00684L11.9812 7V5C8.11518 5 4.98117 8.13401 4.98117 12C4.98117 14.1613 5.96141 16.0929 7.5007 17.377L5.87473 18.6104C4.09571 16.9661 2.98117 14.6135 2.98117 12C2.98117 7.02944 7.01061 3 11.9812 3V1L15.9812 4.00684Z" fill="currentColor"/>'),
  // no firmware equivalent (there's no dedicated console/terminal glyph in the set).
  terminal: s('<polyline points="4 6 10 12 4 18"/><line x1="12" y1="18" x2="20" y2="18"/>'),
  // firmware: edit.svg
  edit: f('<path fill-rule="evenodd" clip-rule="evenodd" d="M15.9493 3.79291C16.3398 3.40254 16.9738 3.40251 17.3643 3.79291L20.1924 6.62103C20.5824 7.01121 20.583 7.64353 20.1934 8.03412L7.7569 20.4999H3.51471V16.2265L15.9493 3.79291ZM5.51471 17.0556V18.4999H6.9278L15.2667 10.1386L13.8487 8.72064L5.51471 17.0556ZM15.2628 7.30658L16.6788 8.72259L18.0714 7.32806L16.6563 5.91302L15.2628 7.30658Z" fill="currentColor"/>'),
  // firmware: trash.svg — small/inline delete affordances (env-var rows, repo unlink).
  trash: f('<path d="M18 18C18 19.6569 16.6569 21 15 21H9C7.34315 21 6 19.6569 6 18L5.59082 9H7.59277L7.99805 17.9092L8 17.9541V18C8 18.5523 8.44772 19 9 19H15C15.5523 19 16 18.5523 16 18V17.9541L16.002 17.9092L16.4072 9H18.4092L18 18Z" fill="currentColor"/><path d="M15 5H20V7H4V5H9V3H15V5Z" fill="currentColor"/>'),
  // firmware: trash-fill.svg — heavier weight for the primary destructive actions
  // (delete variation, uninstall from the library).
  trashFill: f('<path d="M18 18C18 19.6569 16.6569 21 15 21H9C7.34315 21 6 19.6569 6 18L5.59082 9H18.4092L18 18Z" fill="currentColor"/><path d="M15 5H20V7H4V5H9V3H15V5Z" fill="currentColor"/>'),
  // firmware: plus.svg
  plus: f('<path d="M13.0002 11H19V13H13.0002V19H11.0002V13H5V11H11.0002V5H13.0002V11Z" fill="currentColor"/>'),
  // no firmware equivalent (no dedicated floppy/save glyph in the set).
  save: s('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/>'),
  // firmware: control-play.svg — Apps tab + Apps card badge.
  play: f('<path d="M17.9988 12L7.99878 18V6L17.9988 12Z" fill="currentColor"/>'),
  // firmware: search.svg
  search: f('<path fill-rule="evenodd" clip-rule="evenodd" d="M10.793 3.5C14.9351 3.5 18.293 6.85786 18.293 11C18.293 12.6041 17.7874 14.0892 16.9297 15.3086L20.707 19.0859L19.293 20.5L15.5723 16.7793C14.2745 17.8537 12.6094 18.5 10.793 18.5C6.65083 18.5 3.29297 15.1421 3.29297 11C3.29297 6.85786 6.65083 3.5 10.793 3.5ZM10.793 5.5C7.7554 5.5 5.29297 7.96243 5.29297 11C5.29297 14.0376 7.7554 16.5 10.793 16.5C13.8305 16.5 16.293 14.0376 16.293 11C16.293 7.96243 13.8305 5.5 10.793 5.5Z" fill="currentColor"/>'),
  // no firmware equivalent (the set has no eye glyph) — reveal/hide toggle for
  // the password inputs that hold a token.
  eye: s('<path d="M2.6 12S6 5.75 12 5.75 21.4 12 21.4 12 18 18.25 12 18.25 2.6 12 2.6 12Z"/><circle cx="12" cy="12" r="3.1"/>'),
  eyeOff: s('<path d="M10.7 6.05A9.6 9.6 0 0 1 12 5.75c6 0 9.4 6.25 9.4 6.25a17.4 17.4 0 0 1-3.2 4.05"/><path d="M6.3 7.85A17 17 0 0 0 2.6 12S6 18.25 12 18.25a9.7 9.7 0 0 0 3.4-.6"/><path d="M9.8 9.8a3.1 3.1 0 0 0 4.4 4.4"/><line x1="4" y1="4" x2="20" y2="20"/>'),
  // firmware: archive.svg — no dedicated "library" icon in the set; archive reads
  // best for "a shelf of installable apps" and is used consistently for the tab
  // + section-card + catalog cards.
  library: f('<path d="M14 15H10V13H12V11H14V15Z" fill="currentColor"/><path d="M12 11H10V9H12V11Z" fill="currentColor"/><path d="M14 9H12V7H14V9Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M18.1543 3.00391C19.7394 3.08421 21 4.39489 21 6V18L20.9961 18.1543C20.9184 19.6883 19.6883 20.9184 18.1543 20.9961L18 21H6C4.39489 21 3.08421 19.7394 3.00391 18.1543L3 18V6C3 4.34315 4.34315 3 6 3H18L18.1543 3.00391ZM6 5C5.44772 5 5 5.44772 5 6V18C5 18.5523 5.44772 19 6 19H18C18.5523 19 19 18.5523 19 18V6C19 5.44772 18.5523 5 18 5H12V7H10V5H6Z" fill="currentColor"/>'),
  // firmware: download.svg
  download: f('<path d="M4 17.4775C4 18.3181 4.68189 19 5.52246 19H18.4775C19.3181 19 20 18.3181 20 17.4775V15H22V17.4775C22 19.4227 20.4227 21 18.4775 21H5.52246C3.57732 21 2 19.4227 2 17.4775V15H4V17.4775Z" fill="currentColor"/><path d="M13 10H17L12 16L7 10H11V3H13V10Z" fill="currentColor"/>'),
  // firmware: wifi-4.svg — connected state (busybar-manager only cares about the
  // network link to the bar, so wifi covers "reachable" on its own).
  wifi: f('<path d="M12.002 15.6992C12.9141 15.6994 13.7466 16.0392 14.3809 16.5986L12 19.2979L9.62012 16.6006C10.2548 16.0399 11.0886 15.6992 12.002 15.6992Z" fill="currentColor"/><path d="M12.001 9.7002C14.4631 9.70038 16.7411 10.4838 18.6045 11.8115L17.0068 13.6221C15.5757 12.6616 13.8539 12.1008 12.001 12.1006C10.1471 12.1006 8.42384 12.6609 6.99219 13.6221L5.39453 11.8125C7.25845 10.4839 9.53774 9.7002 12.001 9.7002Z" fill="currentColor"/><path d="M12 3.70215C15.9753 3.70237 19.6274 5.08463 22.5039 7.39355L20.9141 9.19434C18.4626 7.25821 15.3661 6.10276 12 6.10254C8.63349 6.10254 5.53666 7.25803 3.08496 9.19434L1.49609 7.39258C4.37267 5.08398 8.02486 3.70215 12 3.70215Z" fill="currentColor"/>'),
  // firmware: alert.svg — not-connected / error state.
  alert: f('<path d="M11.1382 2.4847C11.5266 1.83731 12.4659 1.83728 12.8545 2.4847L21.8559 17.4847C22.2308 18.1096 21.8319 18.8941 21.1399 18.9896L20.9982 18.9993H3.00223L2.85962 18.9896C2.16801 18.8939 1.76913 18.1095 2.14361 17.4847L11.1382 2.4847ZM4.76735 16.9993H19.2312L11.9958 4.94368L4.76735 16.9993Z" fill="currentColor"/><path d="M11.0024 7.99657H13.0029V13.0145H11.0024V7.99657Z" fill="currentColor"/><path d="M11.0024 14.0145H13.0029V16.0145H11.0024V14.0145Z" fill="currentColor"/>'),
  // firmware: moon.svg — shown in light mode (click to go dark).
  moon: f('<path d="M8 7C8 6.74081 8.01195 6.48441 8.03613 6.23145C6.20278 7.49351 5 9.6061 5 12C5 15.866 8.13401 19 12 19V21C7.02944 21 3 16.9706 3 12C3 7.19162 6.77082 3.26487 11.5166 3.01367C10.5735 4.0736 10 5.46964 10 7C10 10.3137 12.6863 13 16 13C18.0079 13 19.7839 12.0126 20.873 10.498C20.9551 10.9866 21 11.4881 21 12C21 16.9706 16.9706 21 12 21V19C14.9478 19 17.4682 17.1771 18.5 14.5977C17.7135 14.8567 16.8738 15 16 15C11.5817 15 8 11.4183 8 7Z" fill="currentColor"/>'),
  // firmware: brightness.svg — shown in dark mode (click to go light).
  sun: f('<path d="M13 22H11V19H13V22Z" fill="currentColor"/><path d="M7.75781 17.6572L5.63672 19.7783L4.22168 18.3643L6.34375 16.2432L7.75781 17.6572Z" fill="currentColor"/><path d="M19.7783 18.3643L18.3643 19.7783L16.2432 17.6572L17.6572 16.2422L19.7783 18.3643Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M12 7C14.7614 7 17 9.23858 17 12C17 14.7614 14.7614 17 12 17C9.23858 17 7 14.7614 7 12C7 9.23858 9.23858 7 12 7ZM12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9Z" fill="currentColor"/><path d="M5 13H2V11H5V13Z" fill="currentColor"/><path d="M22 13H19V11H22V13Z" fill="currentColor"/><path d="M19.7783 5.63574L17.6572 7.75781L16.2422 6.34277L18.3643 4.22168L19.7783 5.63574Z" fill="currentColor"/><path d="M7.75684 6.34277L6.34277 7.75684L4.22168 5.63574L5.63574 4.22168L7.75684 6.34277Z" fill="currentColor"/><path d="M13 5H11V2H13V5Z" fill="currentColor"/>'),
  // firmware: checkmark.svg
  checkmark: f('<path d="M19.6626 6.88037L9.55029 18.437L4.3374 13.2241L5.75146 11.8101L9.45264 15.5112L18.1577 5.56299L19.6626 6.88037Z" fill="currentColor"/>'),
  // firmware: usb-alt.svg — connected-state icon, header "conn" chip (parity
  // with busybar-emulator's App.vue, which always shows a usb glyph there).
  // Same USB status icon as busybar-emulator's header (its icons.js `usb`).
  usb: s('<circle cx="12" cy="20" r="1.6" fill="currentColor" stroke="none"/><path d="M12 20V6M12 6l-2.2 3M12 6l2.2 3M12 13l-4-2.2v-2M12 11l4-2.2V6.5"/>'),
  cloud: s('<path d="M7 18.5a4.5 4.5 0 0 1-.37-8.985A5.5 5.5 0 0 1 17.4 10.1 3.95 3.95 0 0 1 17 18.5Z"/>'),
  usbAlt: f('<path d="M22.9998 12.0003L17.9998 15.0003V13.0003H10.6188L12.1178 16.0003L12.9998 15.9993V15.0003H16.9998V19.0003H12.9998V17.9993L11.5001 18C11.1212 18.0001 10.7747 17.7861 10.6052 17.4472L8.38176 13.0003H6.82876C6.59211 13.6667 6.1277 14.2282 5.51746 14.5856C4.90722 14.943 4.19036 15.0734 3.49333 14.9539C2.7963 14.8343 2.1639 14.4724 1.70768 13.932C1.25146 13.3916 1.00074 12.7075 0.999757 12.0003C0.999229 11.321 1.22923 10.6617 1.65213 10.1301C2.07503 9.59858 2.6658 9.22629 3.3278 9.07415C3.9898 8.922 4.68383 8.99902 5.29636 9.29259C5.9089 9.58617 6.40368 10.0789 6.69976 10.6903L9.70119 6.42458C9.88839 6.15854 10.1933 6.00017 10.5186 6.00003L12.2678 5.99926C12.488 5.61808 12.8278 5.32021 13.2346 5.15183C13.6413 4.98346 14.0922 4.95398 14.5174 5.06798C14.9426 5.18198 15.3183 5.43308 15.5863 5.78235C15.8543 6.13162 15.9995 6.55954 15.9995 6.99976C15.9995 7.43998 15.8543 7.8679 15.5863 8.21716C15.3183 8.56643 14.9426 8.81754 14.5174 8.93153C14.0922 9.04553 13.6413 9.01606 13.2346 8.84768C12.8278 8.6793 12.488 8.38143 12.2678 8.00026L10.9998 8.00026L8.91376 11.0003H17.9998L17.9998 9.00026L22.9998 12.0003ZM4.99976 12.0003C4.99976 11.735 4.8944 11.4807 4.70686 11.2931C4.51933 11.1056 4.26497 11.0003 3.99976 11.0003C3.73454 11.0003 3.48019 11.1056 3.29265 11.2931C3.10511 11.4807 2.99976 11.735 2.99976 12.0003C2.99976 12.2655 3.10511 12.5198 3.29265 12.7074C3.48019 12.8949 3.73454 13.0003 3.99976 13.0003C4.26497 13.0003 4.51933 12.8949 4.70686 12.7074C4.8944 12.5198 4.99976 12.2655 4.99976 12.0003Z" fill="currentColor"/>'),
}

// Header battery states, matched 1:1 to the firmware's own SVGs in
// busybar-firmware/assets/frontend/assets/icons/busy/battery-*.svg (28×24
// viewBox). Kept as its own viewBox/helper since these are wider than the
// 24×24 set above and rely on fill-opacity layering (shell/pin at 0.3, charge
// level at 0.2) that must survive verbatim — do NOT flatten it in CSS.
const b = (inner) => `<svg viewBox="0 0 28 24" fill="none">${inner}</svg>`
const BATT_SHELL = '<path d="M23 18V19H3V18H23ZM25 16V8C25 6.89543 24.1046 6 23 6H3C1.89543 6 1 6.89543 1 8V16C1 17.1046 1.89543 18 3 18V19C1.39489 19 0.0842144 17.7394 0.00390625 16.1543L0 16V8C1.28853e-07 6.34315 1.34315 5 3 5H23L23.1543 5.00391C24.7394 5.08421 26 6.39489 26 8V16L25.9961 16.1543C25.9184 17.6883 24.6883 18.9184 23.1543 18.9961L23 19V18C24.1046 18 25 17.1046 25 16Z" fill="currentColor" fill-opacity="0.3"/><path d="M27 9H28V15H27V9Z" fill="currentColor" fill-opacity="0.3"/>'
export const batteryIcons = {
  charging: b('<defs><linearGradient id="paint0_linear_3674_35354" x1="24" y1="12" x2="2" y2="12" gradientUnits="userSpaceOnUse"><stop stop-color="white"/><stop offset="1" stop-color="white" stop-opacity="0.6"/></linearGradient><linearGradient id="paint1_linear_3674_35354" x1="24" y1="12" x2="2" y2="12" gradientUnits="userSpaceOnUse"><stop stop-color="white"/><stop offset="1" stop-color="white" stop-opacity="0.6"/></linearGradient></defs><g fill="none"><path d="M27 9H28V15H27V9Z" fill="currentColor" fill-opacity="0.3"/><path d="M12.1963 6H3C1.89543 6 1 6.89543 1 8V16C1 17.1046 1.89543 18 3 18H11V19H3C1.39489 19 0.0842144 17.7394 0.00390625 16.1543L0 16V8C1.28853e-07 6.34315 1.34315 5 3 5H12.8213L12.1963 6Z" fill="currentColor" fill-opacity="0.3"/><path d="M23.1543 5.00391C24.7394 5.08421 26 6.39489 26 8V16L25.9961 16.1543C25.9184 17.6883 24.6883 18.9184 23.1543 18.9961L23 19H13.1787L13.8037 18H23C24.1046 18 25 17.1046 25 16V8C25 6.89543 24.1046 6 23 6H15V5H23L23.1543 5.00391Z" fill="currentColor" fill-opacity="0.3"/><path d="M8.15234 12.4697C7.95977 12.7778 7.94903 13.1665 8.125 13.4844C8.30123 13.8023 8.63647 14 9 14H11V17H3.16699C2.52266 17 2 16.4773 2 15.833V8.16699C2 7.52266 2.52266 7 3.16699 7H11.5713L8.15234 12.4697Z" fill="url(#paint0_linear_3674_35354)" fill-opacity="0.2"/><path d="M22.833 7C23.4773 7 24 7.52266 24 8.16699V15.833C24 16.4773 23.4773 17 22.833 17H14.4287L17.8477 11.5303C18.0402 11.2222 18.051 10.8335 17.875 10.5156C17.6988 10.1977 17.3635 10 17 10H15V7H22.833Z" fill="url(#paint1_linear_3674_35354)" fill-opacity="0.2"/><path d="M9 13L14 5V11H17L12 19V13H9Z" fill="#00C16A"/></g>'),
  // charging-lightning.svg — overlaid on `charging` at size-7 (28×28) the same
  // way the firmware's BatteryIndicator stacks it; its own 24×24 viewBox so the
  // bolt scales/centres over the battery body exactly like on the device.
  chargingLightning: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 11H15L10 19V13H7L12 5V11Z" fill="#00C16A"/></svg>',
  full: b(`<g fill="none">${BATT_SHELL}<rect x="2" y="7" width="22" height="10" rx="1.16667" fill="currentColor" fill-opacity="0.2"/></g>`),
  discharging1: b(`<g fill="none">${BATT_SHELL}<path d="M2 8C2 7.44772 2.44772 7 3 7H21V17H3C2.44771 17 2 16.5523 2 16V8Z" fill="currentColor" fill-opacity="0.2"/></g>`),
  discharging2: b(`<g fill="none">${BATT_SHELL}<path d="M2 8C2 7.44772 2.44772 7 3 7H15V17H3C2.44772 17 2 16.5523 2 16V8Z" fill="currentColor" fill-opacity="0.2"/></g>`),
  discharging3: b(`<g fill="none">${BATT_SHELL}<path d="M2 7.99997C2 7.44769 2.44771 6.99998 2.99998 6.99997L9 6.99988V16.9999L3.00002 17C2.44772 17 2 16.5523 2 16V7.99997Z" fill="currentColor" fill-opacity="0.2"/></g>`),
  error: b('<g fill="none"><path d="M27 9H28V15H27V9Z" fill="currentColor" fill-opacity="0.3"/><path d="M3 6C1.89543 6 1 6.89543 1 8V16C1 17.1046 1.89543 18 3 18H11V19H3C1.39489 19 0.0842144 17.7394 0.00390625 16.1543L0 16V8C1.28853e-07 6.34315 1.34315 5 3 5H23L23.1543 5.00391C24.7394 5.08421 26 6.39489 26 8V16L25.9961 16.1543C25.9184 17.6883 24.6883 18.9184 23.1543 18.9961L23 19H15V18H23C24.1046 18 25 17.1046 25 16V8C25 6.89543 24.1046 6 23 6H3Z" fill="currentColor" fill-opacity="0.3"/><path d="M12 8H14V15H12V8Z" fill="#FF6060"/><path d="M12 17H14V19H12V17Z" fill="#FF6060"/></g>'),
}
