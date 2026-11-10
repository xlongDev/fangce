import { lazy } from "react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router-dom";

import { AppProviders } from "@/app/providers";
import { AppShell } from "@/components/layout/AppShell";
import { LibraryPage } from "@/features/library/LibraryPage";

// Library stays eager (landing route); the other pages split into their own
// chunks and load from local disk on first navigation.
const ReaderPage = lazy(() =>
  import("@/features/reader/ReaderPage").then((m) => ({ default: m.ReaderPage })),
);
const SearchPage = lazy(() =>
  import("@/features/search/SearchPage").then((m) => ({ default: m.SearchPage })),
);
const SettingsPage = lazy(() =>
  import("@/features/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const StatsPage = lazy(() =>
  import("@/features/stats/StatsPage").then((m) => ({ default: m.StatsPage })),
);
const NotesPage = lazy(() =>
  import("@/features/notes/NotesPage").then((m) => ({ default: m.NotesPage })),
);

const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <LibraryPage filter="all" /> },
      { path: "recent", element: <LibraryPage filter="recent" /> },
      { path: "favorites", element: <LibraryPage filter="favorites" /> },
      { path: "tags", element: <LibraryPage filter="tags" /> },
      { path: "trash", element: <LibraryPage filter="trash" /> },
      { path: "notes", element: <NotesPage /> },
      { path: "reader", element: <ReaderPage /> },
      { path: "search", element: <SearchPage /> },
      { path: "stats", element: <StatsPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
];

const router = createMemoryRouter(routes, {
  initialEntries: ["/"],
});

export function AppRouter() {
  // Providers live inside the router so any consumer of AppRouter (app entry,
  // tests, storybook-style mounts) gets the same assembled tree.
  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
