import type { Metadata } from "next"
import type { ReactNode } from "react"
import "./styles.css"

export const metadata: Metadata = {
  title: "Parcare Aeroport Iași",
  description: "Panoul de administrare al parcării",
  robots: { index: false, follow: false },
}

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="ro"><body>{children}</body></html>
}
