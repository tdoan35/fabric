import { Outlet } from "react-router";
import { AppShell } from "@/components/shell/app-shell";

export function RootLayout() {
  return <AppShell><Outlet /></AppShell>;
}
