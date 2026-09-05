export type ClassValue =
  | string
  | false
  | null
  | undefined
  | ClassValue[]
  | Record<string, boolean | null | undefined>;

export function cx(...values: ClassValue[]): string {
  const classes: string[] = [];

  for (const value of values) {
    if (!value) continue;
    if (typeof value === "string") {
      classes.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      const nested = cx(...value);
      if (nested) classes.push(nested);
      continue;
    }
    for (const [name, enabled] of Object.entries(value)) {
      if (enabled) classes.push(name);
    }
  }

  return classes.join(" ");
}

export type Tone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "critical";

export type Size = "sm" | "md" | "lg";

export function toneClass(base: string, tone: Tone): string {
  return tone === "neutral" ? base : `${base} ${base}--${tone}`;
}

export function sizeClass(base: string, size: Size): string {
  return size === "md" ? base : `${base} ${base}--${size}`;
}

export const nt = {
  app: "nt-app",
  appFill: "nt-app nt-app--fill",
  page: "nt-page",
  pageHeader: "nt-page-header",
  pageMain: "nt-page-main",
  pageFooter: "nt-page-footer",
  commandBar: "nt-command-bar",
  pane: "nt-pane",
  paneHeader: "nt-pane-header",
  paneBody: "nt-pane-body",
  paneFooter: "nt-pane-footer",
  stack: "nt-stack",
  stackTight: "nt-stack nt-stack--tight",
  cluster: "nt-cluster",
  toolbar: "nt-toolbar",
  grid: "nt-grid",
  gridCompact: "nt-grid nt-grid--compact",
  split: "nt-split",
  scroll: "nt-scroll",
  scrollX: "nt-scroll-x",
  tableWrap: "nt-table-wrap",
  divider: "nt-divider",
  section: "nt-section",
  sectionHeader: "nt-section-header",
  sectionHeading: "nt-section-heading",
  sectionCount: "nt-section-count",
  title: "nt-title",
  subtitle: "nt-subtitle",
  sectionTitle: "nt-section-title",
  eyebrow: "nt-eyebrow",
  text: "nt-text",
  muted: "nt-muted",
  meta: "nt-meta",
  code: "nt-code",
  pre: "nt-pre",
  preWrap: "nt-pre nt-pre--wrap",
  srOnly: "nt-sr-only",
  panel: "nt-panel",
  panelFlat: "nt-panel nt-panel--flat",
  card: "nt-card",
  metric: "nt-metric",
  metricLabel: "nt-metric-label",
  metricValue: "nt-metric-value",
  metricDetail: "nt-metric-detail",
  detailGrid: "nt-detail-grid",
  detail: "nt-detail",
  detailLabel: "nt-detail-label",
  detailValue: "nt-detail-value",
  settingsList: "nt-settings-list",
  settingsRow: "nt-settings-row",
  settingsIcon: "nt-settings-icon",
  settingsMain: "nt-settings-main",
  settingsTitle: "nt-settings-title",
  settingsDescription: "nt-settings-description",
  settingsMeta: "nt-settings-meta",
  settingsActions: "nt-settings-actions",
  disclosure: "nt-disclosure",
  disclosureTrigger: "nt-disclosure-trigger",
  disclosureIcon: "nt-disclosure-icon",
  disclosureCopy: "nt-disclosure-copy",
  disclosureTitle: "nt-disclosure-title",
  disclosureDescription: "nt-disclosure-description",
  disclosureChevron: "nt-disclosure-chevron",
  disclosureContent: "nt-disclosure-content",
  result: "nt-result",
  callout: "nt-callout",
  dialog: "nt-dialog",
  button: "nt-button",
  buttonSecondary: "nt-button nt-button--secondary",
  buttonGhost: "nt-button nt-button--ghost",
  buttonDanger: "nt-button nt-button--danger",
  buttonCritical: "nt-button nt-button--critical",
  buttonWarning: "nt-button nt-button--warning",
  iconButton: "nt-icon-button",
  buttonGroup: "nt-button-group",
  segmented: "nt-segmented",
  tabs: "nt-tabs",
  tabList: "nt-tab-list",
  tab: "nt-tab",
  form: "nt-form",
  formGrid: "nt-form-grid",
  formGridTwo: "nt-form-grid nt-form-grid--two",
  field: "nt-field",
  label: "nt-label",
  help: "nt-help",
  error: "nt-error",
  required: "nt-required",
  fieldset: "nt-fieldset",
  input: "nt-input",
  textarea: "nt-textarea",
  select: "nt-select",
  checkbox: "nt-checkbox",
  radio: "nt-radio",
  inputGroup: "nt-input-group",
  inputPrefix: "nt-input-prefix",
  inputSuffix: "nt-input-suffix",
  alert: "nt-alert",
  alertWarning: "nt-alert nt-alert--warning",
  alertDanger: "nt-alert nt-alert--danger",
  alertCritical: "nt-alert nt-alert--critical",
  alertSuccess: "nt-alert nt-alert--success",
  badge: "nt-badge",
  badgeInfo: "nt-badge nt-badge--info",
  badgeSuccess: "nt-badge nt-badge--success",
  badgeWarning: "nt-badge nt-badge--warning",
  badgeDanger: "nt-badge nt-badge--danger",
  badgeCritical: "nt-badge nt-badge--critical",
  tagList: "nt-tag-list",
  tag: "nt-tag",
  tagSelected: "nt-tag nt-tag--selected",
  tagSuccess: "nt-tag nt-tag--success",
  tagWarning: "nt-tag nt-tag--warning",
  tagDanger: "nt-tag nt-tag--danger",
  state: "nt-state",
  stateEmpty: "nt-state nt-state--empty",
  stateLoading: "nt-state nt-state--loading",
  stateError: "nt-state nt-state--error",
  statePartial: "nt-state nt-state--partial",
  stateSuccess: "nt-state nt-state--success",
  spinner: "nt-spinner",
  progress: "nt-progress",
  statusDot: "nt-status-dot",
  copyField: "nt-copy-field",
  table: "nt-table",
  list: "nt-list",
  json: "nt-json",
  kv: "nt-kv",
  dialogBody: "nt-dialog-body",
  dialogActions: "nt-dialog-actions"
} as const;
