// Make clicking the toolbar icon open the docked side panel (which, unlike a
// popup, stays open while the form page reloads between ASP.NET postbacks).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("sidePanel setPanelBehavior failed:", err));
