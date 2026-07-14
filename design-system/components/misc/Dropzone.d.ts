export interface DropzoneProps {
  label: React.ReactNode;
  /** Filename of the currently loaded file, shown below the label */
  filename?: string;
  onFiles?: (files: FileList) => void;
  accept?: string;
}
/**
 * @startingPoint section="Misc" subtitle="Drag-and-drop file target (SVG / STL)" viewport="320x120"
 */
export declare function Dropzone(props: DropzoneProps): JSX.Element;
