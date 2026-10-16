import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TONLY | Predictive Maintenance Intelligence",
  description: "Source-driven preventive maintenance forecasting, charging-log quality checks and controlled fleet import workflows for TONLY electric mining trucks.",
  applicationName: "TONLY Predictive Maintenance Intelligence",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
