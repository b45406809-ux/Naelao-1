import { redirect } from "next/navigation";

/** Spaces belong to Launchpad users; the team dashboard manages the platform. */
export default function SpacesPage() {
  redirect("/dashboard");
}
