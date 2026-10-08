import "./globals.css";

export const metadata = {
  title: "NexusClin — Trial Eligibility Intelligence",
  description: "AI-assisted, evidence-grounded clinical trial eligibility matching powered by Google Gemini.",
  keywords: "clinical trial, eligibility, AI, PDF analysis, medical, Gemini",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body>{children}</body>
    </html>
  );
}
