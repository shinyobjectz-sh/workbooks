/**
 * @signal/workbook-runtime — Svelte 5 components that render the workbook
 * block tree.
 *
 * The root `Workbook` component is built in apps/web/src/lib/workbook/ for now
 * (it imports a few app-specific helpers). It will move into this package
 * once those deps are decoupled. See README.md > Migration status.
 */

// Block components (clean — no convex coupling)
export { default as HeadingBlock } from "./blocks/Heading.svelte";
export { default as ParagraphBlock } from "./blocks/Paragraph.svelte";
export { default as MarkdownBlock } from "./blocks/Markdown.svelte";
export { default as CalloutBlock } from "./blocks/Callout.svelte";
export { default as DividerBlock } from "./blocks/Divider.svelte";
export { default as CodeBlock } from "./blocks/Code.svelte";
export { default as DiagramBlock } from "./blocks/Diagram.svelte";
export { default as ChartBlock } from "./blocks/Chart.svelte";
export { default as MetricBlock } from "./blocks/Metric.svelte";
export { default as MetricsBlock } from "./blocks/Metrics.svelte";
export { default as TableBlock } from "./blocks/Table.svelte";
export { default as StepBlock } from "./blocks/Step.svelte";
export { default as MachineBlock } from "./blocks/Machine.svelte";
export { default as WidgetBlock } from "./blocks/Widget.svelte";
export { default as NetworkBlock } from "./blocks/Network.svelte";
export { default as GeoBlock } from "./blocks/Geo.svelte";
export { default as Embedding3DBlock } from "./blocks/Embedding3D.svelte";

// Context stores
export {
  setWorkbookContext,
  getWorkbookContext,
} from "./workbookContext";
export type { WorkbookContext } from "./workbookContext";

export {
  setCitationContext,
  getCitationContext,
  buildCitationContext,
} from "./citationContext";
