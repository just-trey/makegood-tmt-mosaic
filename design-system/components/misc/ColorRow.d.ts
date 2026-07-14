export interface ColorRowProps {
  hex: string;
  areaPct?: number;
  depth?: number;
  onDepthChange?: (depth: number) => void;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
}
/**
 * @startingPoint section="Misc" subtitle="Detected-color list item with depth override" viewport="300x90"
 */
export declare function ColorRow(props: ColorRowProps): JSX.Element;
