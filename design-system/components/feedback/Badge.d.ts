export interface BadgeProps {
  children: React.ReactNode;
  /** @default 'neutral' */
  tone?: 'neutral' | 'accent';
}
/**
 * @startingPoint section="Feedback" subtitle="Mono status readout (header stats, slot count)" viewport="200x40"
 */
export declare function Badge(props: BadgeProps): JSX.Element;
