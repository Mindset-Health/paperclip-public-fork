// Dixie Flatline: the robot-and-lettering banner from the original Dixie
// console, shown above the app shell. Styles live in dixie-theme.css.
export function DixieBanner() {
  return (
    <header className="dixie-banner" data-testid="dixie-banner">
      <img
        src="/dixie-flatline-banner.webp"
        alt="Dixie Flatline"
        width={1400}
        height={175}
        decoding="async"
      />
    </header>
  );
}
