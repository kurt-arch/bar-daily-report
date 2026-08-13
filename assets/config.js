/* ==========================================================================
   Bar Daily Report — front-end configuration
   Edit this file (and only this file) to change venues, tolerances or the
   backend endpoint. No rebuild step required.
   ========================================================================== */

window.PORTAL_CONFIG = {

  /* Apps Script Web App URL (deployment @1, created 13 Aug 2026).
     Re-deploy with `clasp create-deployment` after changing Code.gs — the URL
     stays the same only if you redeploy the same deployment id. */
  endpoint: 'https://script.google.com/macros/s/AKfycbwWA0ryaK8vow0iTu5GSnlgc35r5RMGaZH-NMXc1xh4U2EYIXLOs0iumGsxI4sJVtVj/exec',

  /* Venues, in the same order as the original Google Form dropdown.
     `forecast: false` means no forecast workbook exists for that venue, so
     the panel shows "no forecast available" instead of flagging. */
  venues: [
    { name: 'Island Bar',             forecast: true  },
    { name: 'Boat House',             forecast: true  },
    { name: 'Shed Bar',               forecast: false },
    { name: 'Kbs',                    forecast: true  },
    { name: 'Scary Canary',           forecast: true  },
    { name: 'Red Eye',                forecast: true  },
    { name: 'Arts Factory Garden Bar', forecast: true }
  ],

  /* Google Sign-In gate.
     Managers must sign in with a Google account on `allowedDomain`. The browser
     receives a signed ID token; every request carries it and Apps Script
     verifies it server-side, so this cannot be bypassed by editing the page.
     Leaving someone's Workspace account suspended revokes their access with no
     further action here.

     `clientId` comes from a Google Cloud OAuth 2.0 Web client whose authorised
     JavaScript origin is the GitHub Pages URL — see README "Set up sign-in".
     Set enabled:false only for local development. */
  auth: {
    enabled: true,
    clientId: '502160935588-21v9r0sbtqmb34thtgkelb8f0qiq3dqm.apps.googleusercontent.com',
    allowedDomain: 'nomadsworld.com'
  },

  /* GST basis.
     Managers type GST-INCLUSIVE figures (that is what column E of the response
     sheet has always held), but the forecast workbooks project revenue EX GST
     ("Projected Revenue Ex GST"). Revenue must therefore be stripped before it
     is compared, or every venue looks ~10% better than it is.
     These values match CONFIG.GST_RATE / ACTUALS_INCLUDE_GST in the existing
     Group Live P&L Dashboard, so both tools agree. */
  gst: {
    actualsIncludeGst: true,
    rate: 0.10,

    /* Which revenue basis the ACTUAL wage percentages divide by.
       'ex-gst'   (chosen) compares like with like against the projected wage %,
                  which the forecast workbooks calculate on ex-GST revenue.
       'inc-gst'  reproduces the older reporting: it ties to the "Actual … wage %"
                  columns in the forecast workbooks and to the Wage Cost %
                  managers used to type into column Q, but reads 9.1% (the GST
                  factor) more favourably than reality.
       Wage Cost % written to column Q now follows this setting, so it will read
       ~9% higher than historical rows. That is the correction, not a regression. */
    wagePctBasis: 'ex-gst'
  },

  /* Flag bands, as percentage difference from forecast. Taken from
     CONFIG.STATUS_THRESHOLDS in the Group Live P&L Dashboard so the portal and
     the dashboard classify the same night the same way.
       revenue: green at or above -2%, amber to -7%, red below
       wage:    green at or below +2%, amber to +5%, red above
     Only red requires a written explanation. */
  tolerances: {
    revenueGreenPct: -2.0,
    revenueAmberPct: -7.0,
    wageGreenPct: 2.0,
    wageAmberPct: 5.0
  },

  /* Per-file upload ceiling. Apps Script accepts roughly 50MB of POST body,
     and base64 inflates by ~33%, so keep this well under that. */
  maxUploadMB: 20,

  /* Draft autosave key. Drafts are held in localStorage so a manager who
     closes the tab mid-report does not lose the night's numbers. */
  draftKey: 'barDailyReport.draft.v1'
};
