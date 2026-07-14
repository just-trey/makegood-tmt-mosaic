export interface TextInputProps {
  /** @default 'text' */
  type?: 'text' | 'number';
  value?: string | number;
  onChange?: (value: string) => void;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}
/**
 * @startingPoint section="Forms" subtitle="Text and numeric fields (mm/mono values)" viewport="240x60"
 */
export declare function TextInput(props: TextInputProps): JSX.Element;
