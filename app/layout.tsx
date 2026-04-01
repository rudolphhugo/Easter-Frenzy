import type { Metadata } from "next";
import { Erica_One, Nunito } from "next/font/google";
import "./globals.css";

const ericaOne = Erica_One({
  variable: "--font-erica-one",
  subsets: ["latin"],
  weight: "400",
});

const nunito = Nunito({
  variable: "--font-nunito",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
});

export const metadata: Metadata = {
  title: "Easter Frenzy",
  description: "Catch Easter eggs with your mouth — 5 stages of eggy chaos!",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${ericaOne.variable} ${nunito.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
