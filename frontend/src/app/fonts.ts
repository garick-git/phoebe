import { Geist, Geist_Mono } from "next/font/google";

// next/font downloads these at build time and serves them from Phoebe's own
// files, so visitors' browsers never contact Google (privacy, and no extra
// connection before text renders).
export const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});
