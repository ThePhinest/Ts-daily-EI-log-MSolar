// ============================================================
// MORAINE SOLAR ENERGY CENTER
// Daily Environmental Compliance Report — Master Build Script
// Last updated: 2026-03-12
//
// Usage: node build_report_MASTER.js <json_path> <photo_dir> [out_dir]
// json_path : path to JSON file exported from Moraine EI Field Log app
// photo_dir : folder containing Solocator/field JPEGs for today
// out_dir   : output directory (default: /mnt/user-data/outputs)
// ============================================================

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, HeadingLevel, BorderStyle, WidthType, ShadingType,
  LevelFormat, PageNumber, Header, Footer, TabStopType, TabStopPosition,
  ImageRun
} = require('/home/claude/.npm-global/lib/node_modules/docx');

const fs   = require('fs');
const path = require('path');

const BLUE       = "1F3864";
const LIGHT_BLUE = "D9E2F3";
const MID_BLUE   = "2E5496";
const WHITE      = "FFFFFF";
const GRAY_BG    = "F2F2F2";

const bdr      = { style: BorderStyle.SINGLE, size: 1, color: "AAAAAA" };
const borders  = { top: bdr, bottom: bdr, left: bdr, right: bdr };
const noBdr    = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders= { top: noBdr, bottom: noBdr, left: noBdr, right: noBdr };

// ── HELPERS ──────────────────────────────────────────────────
const spacer = (pts=80) =>
  new Paragraph({ spacing:{ before:0, after:pts } });

const heading1 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children:[ new TextRun({ text, bold:true, color:WHITE, font:"Arial", size:26 }) ],
    shading:{ fill:BLUE, type:ShadingType.CLEAR },
    spacing:{ before:200, after:100 },
    indent:{ left:120 }
  });

const heading2 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children:[ new TextRun({ text, bold:true, color:MID_BLUE, font:"Arial", size:22 }) ],
    spacing:{ before:160, after:60 },
    border:{ bottom:{ style:BorderStyle.SINGLE, size:4, color:MID_BLUE, space:1 } }
  });

const body = (text, opts={}) =>
  new Paragraph({
    children:[ new TextRun({ text, font:"Arial", size:20, ...opts }) ],
    spacing:{ before:40, after:40 }
  });

const bullet = (text) =>
  new Paragraph({
    numbering:{ reference:"bullets", level:0 },
    children:[ new TextRun({ text, font:"Arial", size:20 }) ],
    spacing:{ before:20, after:20 }
  });

// ── INFO TABLE ────────────────────────────────────────────────
function infoTable(longDate, contractors, activePhase){
  const cw1=2800, cw2=6560;
  const row = (label, value) => new TableRow({ children:[
    new TableCell({ borders, width:{ size:cw1, type:WidthType.DXA },
      shading:{ fill:LIGHT_BLUE, type:ShadingType.CLEAR },
      margins:{ top:80, bottom:80, left:120, right:120 },
      children:[ new Paragraph({ children:[ new TextRun({ text:label, bold:true, font:"Arial", size:20 }) ] }) ]
    }),
    new TableCell({ borders, width:{ size:cw2, type:WidthType.DXA },
      margins:{ top:80, bottom:80, left:120, right:120 },
      children:[ new Paragraph({ children:[ new TextRun({ text:value, font:"Arial", size:20 }) ] }) ]
    })
  ]});
  return new Table({
    width:{ size:9360, type:WidthType.DXA }, columnWidths:[cw1,cw2],
    rows:[
      row("Report Date:",        longDate),
      row("Prepared By:",        "Tim Shortz — Environmental Inspector"),
      row("Organization:",       "London Environmental LLC"),
      row("Project:",            "Moraine Solar Energy Center"),
      row("Active Phase:",       activePhase),
      row("Active Contractors:", contractors),
    ]
  });
}

// ── TWO-COL TABLE ─────────────────────────────────────────────
function twoColTable(pairs){
  const cw1=2800, cw2=6560;
  return new Table({
    width:{ size:9360, type:WidthType.DXA }, columnWidths:[cw1,cw2],
    rows: pairs.map(([label,value]) => new TableRow({ children:[
      new TableCell({ borders, width:{ size:cw1, type:WidthType.DXA },
        shading:{ fill:LIGHT_BLUE, type:ShadingType.CLEAR },
        margins:{ top:80, bottom:80, left:120, right:120 },
        children:[ new Paragraph({ children:[ new TextRun({ text:label, bold:true, font:"Arial", size:20 }) ] }) ]
      }),
      new TableCell({ borders, width:{ size:cw2, type:WidthType.DXA },
        margins:{ top:80, bottom:80, left:120, right:120 },
        children:[ new Paragraph({ children:[ new TextRun({ text:value, font:"Arial", size:20 }) ] }) ]
      })
    ]}))
  });
}

// ── COMPLIANCE TABLE ──────────────────────────────────────────
function complianceTable(issues=[]){
  const widths = [1200,2800,3200,1560];
  const headerRow = new TableRow({ tableHeader:true, children:
    ["Level","Location / Description","Corrective Action","Status"].map((h,i) =>
      new TableCell({ borders, width:{ size:widths[i], type:WidthType.DXA },
        shading:{ fill:BLUE, type:ShadingType.CLEAR },
        margins:{ top:80, bottom:80, left:120, right:120 },
        children:[ new Paragraph({ children:[ new TextRun({ text:h, bold:true, color:WHITE, font:"Arial", size:18 }) ] }) ]
      })
    )
  });
  const dataRows = issues.length === 0
    ? [ new TableRow({ children:
        ["No issues identified",
         "All areas inspected — no compliance concerns observed.",
         "N/A",
         "Compliant"].map((val,i) =>
          new TableCell({ borders, width:{ size:widths[i], type:WidthType.DXA },
            shading:{ fill:GRAY_BG, type:ShadingType.CLEAR },
            margins:{ top:80, bottom:80, left:120, right:120 },
            children:[ new Paragraph({ children:[ new TextRun({ text:val, font:"Arial", size:18 }) ] }) ]
          })
        )
      })]
    : [...issues].sort((a,b)=>b.level-a.level).map(issue =>
        new TableRow({ children:
          [`Level ${issue.level}`, issue.location, issue.action, issue.status].map((val,i) =>
            new TableCell({ borders, width:{ size:widths[i], type:WidthType.DXA },
              shading:{ fill:GRAY_BG, type:ShadingType.CLEAR },
              margins:{ top:80, bottom:80, left:120, right:120 },
              children:[ new Paragraph({ children:[ new TextRun({ text:val, font:"Arial", size:18 }) ] }) ]
            })
          )
        })
      );
  return new Table({ width:{ size:9360, type:WidthType.DXA }, columnWidths:widths, rows:[headerRow,...dataRows] });
}

// ── PHOTO TABLE ───────────────────────────────────────────────
function makePhotoCell(imgBuf, caption){
  if(!imgBuf){
    return new TableCell({ borders:noBorders, width:{ size:4680, type:WidthType.DXA },
      margins:{ top:60, bottom:60, left:120, right:120 },
      children:[ new Paragraph({ children:[] }) ]
    });
  }
  return new TableCell({ borders:noBorders, width:{ size:4680, type:WidthType.DXA },
    margins:{ top:60, bottom:60, left:120, right:120 },
    children:[
      new Paragraph({
        // 331x248px = 3.45"x2.59" confirmed correct
        children:[ new ImageRun({ data:imgBuf, transformation:{ width:331, height:248 }, type:"jpg" }) ],
        spacing:{ before:0, after:40 }
      }),
      new Paragraph({
        children:[ new TextRun({ text:caption, font:"Arial", size:17, italics:true, color:"333333" }) ],
        alignment: AlignmentType.CENTER,
        spacing:{ before:0, after:80 }
      })
    ]
  });
}

function photoTable(photos){
  const rows = [];
  for(let i=0; i<photos.length; i+=2){
    const L = photos[i], R = photos[i+1] || null;
    rows.push(new TableRow({ children:[
      makePhotoCell(L.buf, L.caption),
      makePhotoCell(R ? R.buf : null, R ? R.caption : "")
    ]}));
  }
  return new Table({ width:{ size:9360, type:WidthType.DXA }, columnWidths:[4680,4680], rows });
}

// ── CERT TABLE ────────────────────────────────────────────────
function certTable(shortDate){
  const cw1=2800, cw2=6560;
  const lbl = (text) => new TableCell({ borders, width:{ size:cw1, type:WidthType.DXA },
    shading:{ fill:LIGHT_BLUE, type:ShadingType.CLEAR },
    margins:{ top:80, bottom:80, left:120, right:120 },
    children:[ new Paragraph({ children:[ new TextRun({ text, bold:true, font:"Arial", size:20 }) ] }) ]
  });
  const val = (text, tall=false) => new TableCell({ borders, width:{ size:cw2, type:WidthType.DXA },
    margins:{ top:tall?200:80, bottom:tall?200:80, left:120, right:120 },
    children:[ new Paragraph({ children:[ new TextRun({ text, font:"Arial", size:20 }) ] }) ]
  });
  return new Table({
    width:{ size:9360, type:WidthType.DXA }, columnWidths:[cw1,cw2],
    rows:[
      new TableRow({ children:[ lbl("Name:"),       val("Tim Shortz", true) ] }),
      new TableRow({ children:[ lbl("Title:"),       val("Environmental Inspector") ] }),
      new TableRow({ children:[ lbl("Date:"),        val(shortDate) ] }),
      new TableRow({ children:[ lbl("Reviewed by:"), val("Robert Forest Rung", true) ] }),
    ]
  });
}

// ── PHOTO LOADER ──────────────────────────────────────────────
function loadPhotos(photoDir, extraCaptions={}){
  if(!fs.existsSync(photoDir)) return [];
  return fs.readdirSync(photoDir)
    .filter(f => /\.(jpe?g)$/i.test(f))
    .map(f => {
      const tsMatch = f.match(/(\d{4}-\d{2}-\d{2}[_T]\d{2}[-:]\d{2}[-:]\d{2})/);
      const ts = tsMatch ? tsMatch[1] : null;
      const mt = fs.statSync(path.join(photoDir,f)).mtimeMs;
      return { filename:f, ts, mt };
    })
    .sort((a,b) => {
      if(a.ts && b.ts) return a.ts.localeCompare(b.ts);
      if(a.ts) return -1; if(b.ts) return 1;
      return a.mt - b.mt;
    })
    .map((f,i) => {
      const buf = fs.readFileSync(path.join(photoDir, f.filename));
      let label;
      if(/^IMG_/i.test(f.filename) && extraCaptions[f.filename]){
        label = extraCaptions[f.filename];
      } else {
        const withoutExt = f.filename.replace(/\.(jpe?g)$/i,'');
        const withoutTs  = withoutExt.replace(/_\d{4}-\d{2}-\d{2}[_T]\d{2}[-:]\d{2}[-:]\d{2}$/,'');
        label = withoutTs.replace(/[_]+/g,' ').trim() || 'Site inspection photo';
      }
      return { buf, caption: `Photo ${i+1} \u2014 ${label.charAt(0).toUpperCase()+label.slice(1)}` };
    });
}

// ── TEXT HELPERS ──────────────────────────────────────────────
function isNA(val){ return !val || /^n[\/.]?a\.?$/i.test(val.trim()); }

// Determine felling method from B45 for use in standard observations
function fellingMethod(activities){
  if(!activities) return 'hand-chainsaw';
  const a = activities.toLowerCase();
  if(/bucket|aerial|lift/i.test(a)) return 'bucket-assisted';
  if(/hand|chainsaw/i.test(a)) return 'hand-chainsaw';
  return 'hand-chainsaw'; // default for Phase 1
}

// ── CONTRACTOR ACTIVITIES — polished prose paragraph(s) ──────
function buildContractorActivities(crews){
  if(!crews || crews.length === 0)
    return [body("No contractor personnel were on site during the inspection period.")];

  return crews.map(crew => {
    const method = fellingMethod(crew.activities);
    const methodDesc = method === 'bucket-assisted'
      ? 'bucket truck-assisted and hand-chainsaw tree felling operations'
      : 'hand tree felling operations';

    const loc = crew.location
      ? crew.location.toLowerCase()
      : 'multiple locations throughout the project area';

    return body(
      `${crew.name} personnel were on site from approximately ${crew.time}, ` +
      `conducting ${methodDesc} at ${loc}. ` +
      `Equipment and personnel accessed work areas via pre-existing access routes ` +
      `in accordance with the approved Tree Felling Operations Plan.`
    );
  });
}

// ── FIELD OBSERVATIONS — standard bullets + specific notes ───
// Standard Phase 1 tree felling observations are always included.
// Specific notes from B22, B48 are woven in as additional bullets.
// Agency inspection references are kept brief with pointer to Section 3.
function buildFieldObservations(log, photoCount){
  const bullets = [];
  const method  = fellingMethod(log.crews && log.crews[0] ? log.crews[0].activities : '');

  // ── Standard observation 1: Felling method & equipment
  if(method === 'bucket-assisted'){
    bullets.push(
      "Felling method and equipment: Tree felling was conducted using a combination of bucket truck-assisted " +
      "and hand-chainsaw methods. Equipment was operated by qualified personnel and remained within the staked " +
      "Limits of Disturbance throughout all active work areas."
    );
  } else {
    bullets.push(
      "Felling method and equipment: Hand-chainsaw felling was the sole method employed throughout all active " +
      "work areas, consistent with Phase 1 Tree Felling Operations Plan requirements. No mechanized felling " +
      "equipment was observed."
    );
  }

  // ── Standard observation 2: Directional felling
  bullets.push(
    "Directional felling practices: Trees were felled in a controlled manner, directed away from wetland and " +
    "stream buffer boundaries, flagged ESA boundaries, and adjacent sensitive areas. Felling crews were observed " +
    "assessing directional fall paths prior to cutting."
  );

  // ── Standard observation 3: Slash and material management
  bullets.push(
    "Slash and material management: Felled material and slash were staged within the staked Limits of " +
    "Disturbance adjacent to active felling areas. No slash or woody debris was observed encroaching upon " +
    "wetland buffers, stream crossings, or ESA boundaries."
  );

  // ── Standard observation 4: Stump height
  bullets.push(
    "Stump height: Stumps observed throughout active felling areas were cut at or near ground level, consistent " +
    "with the approved felling plan requirements."
  );

  // ── Standard observation 5: Access and staging
  bullets.push(
    "Access and staging: All equipment and personnel accessed active work areas via pre-existing farm roads and " +
    "designated access routes. No new ground disturbance associated with equipment access was observed outside " +
    "the staked LOD."
  );

  // ── Notes from crew B48
  for(const crew of (log.crews||[])){
    if(crew.notes && crew.notes.trim()){
      crew.notes.split(/\n+/).filter(l=>l.trim()).forEach(l => {
        bullets.push(l.trim().charAt(0).toUpperCase() + l.trim().slice(1));
      });
    }
  }

  // ── Checklist notes — checked items with supplemental notes
  for(const note of (log.checklistNotes||[])){
    bullets.push(note.charAt(0).toUpperCase() + note.slice(1));
  }

  return bullets.map(b => bullet(b));
}

// ── GENERAL COMMS ─────────────────────────────────────────────
function buildGenComms(raw){
  if(!raw || !raw.trim()) return [body("No general communications to report.")];
  const lines = raw.split(/\n+/).filter(l => l.trim());
  if(lines.length === 1) return [body(raw.trim())];
  return [
    body("The following items were communicated to contractor personnel during the inspection period:"),
    spacer(40),
    ...lines.map(l => bullet(l.trim()))
  ];
}

// ── 24-HR LOOK AHEAD ─────────────────────────────────────────
function buildLookahead(raw){
  if(!raw || !raw.trim()) return [body("No look-ahead information available.")];
  return raw.split(/\n+/).filter(l=>l.trim()).map(l => body(l.trim()));
}

// ── DATE HELPERS ──────────────────────────────────────────────
// Input: "2026-03-12" (YYYY-MM-DD from app)
// Outputs: longDate "Wednesday, March 12, 2026"
//          shortDate "3/12/26"
//          rawDate "3-12-2026" (for filename)
function formatDates(iso){
  const [y,m,d] = iso.split('-').map(Number);
  const dt = new Date(y, m-1, d);
  const longDate = dt.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  const shortDate = `${m}/${d}/${String(y).slice(2)}`;
  const rawDate = `${m}-${d}-${y}`;
  return { longDate, shortDate, rawDate };
}

// ── COMPLIANCE ISSUE PARSER ───────────────────────────────────
// Extracts Level 1-4 issues from crew blocks and nonCompliance field.
// Returns { complianceIssues: [], unleveled: [] }
// Unleveled text routes to genComms (caller merges).
function parseComplianceIssues(appData){
  const complianceIssues = [];
  const unleveled = [];

  const sources = [
    ...(appData.crewBlocks || []).map(c => ({ text: c.issues, source: c.name || 'crew' })),
    ...(appData.nonCompliance ? [{ text: appData.nonCompliance, source: 'field' }] : []),
  ];

  sources.forEach(({ text }) => {
    if(!text || !text.trim()) return;
    text.split(/\n+/).forEach(line => {
      line = line.trim();
      if(!line) return;
      const m = line.match(/level\s*([1-4])/i);
      if(m){
        complianceIssues.push({
          level: parseInt(m[1]),
          location: line.replace(/level\s*[1-4]\s*[—\-:]/i,'').trim(),
          action: "See General Communication to Contractors.",
          status: parseInt(m[1]) >= 3 ? "Open" : "Resolved"
        });
      } else {
        unleveled.push(line);
      }
    });
  });

  return { complianceIssues, unleveled };
}

// ── NORMALIZE APP JSON → INTERNAL LOG FORMAT ─────────────────
// Maps field names from the HTML app export to what the
// build functions below expect. Single translation layer —
// build functions remain unchanged.
function normalizeLog(app){
  const dates = formatDates(app.reportDate);
  const { complianceIssues, unleveled } = parseComplianceIssues(app);

  // Combine temperature into single display string
  const tempAM = app.weather?.tempAM ? `${app.weather.tempAM}°F` : null;
  const tempPM = app.weather?.tempPM ? `${app.weather.tempPM}°F` : null;
  const temp = [tempAM, tempPM].filter(Boolean).join(' / ') || '—';

  // Merge genComms + unleveled issues + regulatory flags
  const flagLines = (app.regulatoryFlags || []).map(f => `⚑ FLAG: ${f}`);
  const genCommsParts = [app.generalComms, ...unleveled, ...flagLines].filter(s => s && s.trim());
  const genComms = genCommsParts.join('\n');

  // Checklist notes — checked items with notes → extra field observation bullets
  const checklistNotes = (app.complianceChecklist || [])
    .filter(c => c.checked && c.note && c.note.trim())
    .map(c => c.note.trim());

  // Normalize crew blocks
  const crews = (app.crewBlocks || []).map(c => ({
    name:       c.name       || '',
    time:       c.time       || '',
    location:   c.location   || '',
    activities: c.activities || '',
    envCompliance: c.envCompliance || '',
    notes:      [c.notes, c.envCompliance].filter(s => s && s.trim()).join('\n'),
  }));

  return {
    ...dates,
    skies:          app.weather?.sky             || '—',
    temp,
    precip:         app.weather?.precip          || 'None',
    wind:           app.weather?.wind            ? app.weather.wind : '—',
    soilConditions: app.weather?.soilConditions  || '—',
    upcomingWx:     app.weather?.upcomingForecast|| '—',
    inspSummary:    app.inspectionSummary        || '',
    agencyInsp:     app.agencyInspection         || '',
    landowner:      app.landownerContact         || '',
    rte:            app.rteObservation           || '',
    crews,
    complianceIssues,
    checklistNotes,
    genComms,
    lookahead:      app.lookahead                || '',
    activePhase:    app.activePhase              || 'Phase 1 — Tree Felling',
    contractor:     app.contractor               || 'Supreme Industries',
  };
}

// ── MAIN ──────────────────────────────────────────────────────
async function main(){
  const args     = process.argv.slice(2);
  const jsonPath = args[0];
  const photoDir = args[1];
  const outDir   = args[2] || '/mnt/user-data/outputs';

  if(!jsonPath){
    console.error("Usage: node build_report_MASTER.js <json_path> <photoDir> [outDir]");
    process.exit(1);
  }

  console.log("Reading field log JSON...");
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const app = JSON.parse(raw);
  const log = normalizeLog(app);
  console.log(`  Date: ${log.longDate}`);

  console.log("Loading photos...");
  const photos = loadPhotos(photoDir);
  console.log(`  Found ${photos.length} photos`);

  const contractors = log.crews.length > 0
    ? [...new Set(log.crews.map(c => c.name).filter(Boolean))].join(', ') || log.contractor
    : log.contractor;

  const weatherRows = [
    ["Sky Conditions:",              log.skies          || "—"],
    ["Temperature (AM / PM):",       log.temp           || "—"],
    ["Precipitation:",               isNA(log.precip) ? "None" : (log.precip ? `${log.precip} in.` : "None")],
    ["Wind:",                        log.wind           || "—"],
    ["Soil Conditions:",             log.soilConditions || "—"],
    ["Upcoming Weather:",            log.upcomingWx     || "—"],
  ];

  const agencyText = isNA(log.agencyInsp)
    ? "No agency inspections conducted today."
    : log.agencyInsp.split('\n').filter(l=>l.trim()).join(' ');

  const landownerText = isNA(log.landowner)
    ? "No landowner or public interactions occurred today."
    : log.landowner;

  const rteText = isNA(log.rte)
    ? "No rare, threatened, or endangered species were observed. No unanticipated archaeological or cultural resource discoveries were encountered."
    : log.rte;

  const crewStart = log.crews.length > 0
    ? (log.crews[0].time||'').split(/[-–]/)[0].trim()
    : '—';

  const doc = new Document({
    numbering:{ config:[{ reference:"bullets", levels:[{
      level:0, format:LevelFormat.BULLET, text:"\u2022", alignment:AlignmentType.LEFT,
      style:{ paragraph:{ indent:{ left:720, hanging:360 } } }
    }]}]},
    styles:{
      default:{ document:{ run:{ font:"Arial", size:20 } } },
      paragraphStyles:[
        { id:"Heading1", name:"Heading 1", basedOn:"Normal", next:"Normal", quickFormat:true,
          run:{ size:26, bold:true, font:"Arial", color:WHITE },
          paragraph:{ spacing:{ before:200, after:100 }, outlineLevel:0 } },
        { id:"Heading2", name:"Heading 2", basedOn:"Normal", next:"Normal", quickFormat:true,
          run:{ size:22, bold:true, font:"Arial", color:MID_BLUE },
          paragraph:{ spacing:{ before:160, after:60 }, outlineLevel:1 } }
      ]
    },
    sections:[{
      properties:{ page:{
        size:{ width:12240, height:15840 },
        margin:{ top:1530, right:1080, bottom:1080, left:1080 }
      }},
      headers:{ default: new Header({ children:[
        new Paragraph({
          children:[
            new TextRun({ text:"MORAINE SOLAR ENERGY CENTER", bold:true, font:"Arial", size:22, color:BLUE }),
            new TextRun({ text:"\t" }),
            new TextRun({ text:"Town of Burns, Allegany County, NY", font:"Arial", size:18, color:BLUE }),
          ],
          tabStops:[{ type:TabStopType.RIGHT, position:TabStopPosition.MAX }],
          shading:{ fill:LIGHT_BLUE, type:ShadingType.CLEAR },
          spacing:{ before:60, after:0 }, indent:{ left:120, right:120 },
          border:{
            top:  { style:BorderStyle.SINGLE, size:8, color:BLUE, space:0 },
            left: { style:BorderStyle.SINGLE, size:8, color:BLUE, space:0 },
            right:{ style:BorderStyle.SINGLE, size:8, color:BLUE, space:0 },
          }
        }),
        new Paragraph({
          children:[
            new TextRun({ text:"Daily Environmental Compliance Report", font:"Arial", size:18, color:MID_BLUE }),
          ],
          tabStops:[{ type:TabStopType.RIGHT, position:TabStopPosition.MAX }],
          shading:{ fill:LIGHT_BLUE, type:ShadingType.CLEAR },
          spacing:{ before:0, after:60 }, indent:{ left:120, right:120 },
          border:{
            left:  { style:BorderStyle.SINGLE, size:8, color:BLUE, space:0 },
            bottom:{ style:BorderStyle.SINGLE, size:8, color:BLUE, space:0 },
            right: { style:BorderStyle.SINGLE, size:8, color:BLUE, space:0 },
          }
        }),
      ]})},
      footers:{ default: new Footer({ children:[
        new Paragraph({
          children:[
            new TextRun({ text:"Moraine Solar Energy Center  |  Environmental Inspector Daily Report  |  Confidential  |  Page ", font:"Arial", size:16, color:"555555" }),
            new TextRun({ children:[PageNumber.CURRENT], font:"Arial", size:16, color:"555555" }),
          ],
          border:{ top:{ style:BorderStyle.SINGLE, size:4, color:"AAAAAA", space:4 } },
          spacing:{ before:80 }, alignment:AlignmentType.LEFT
        })
      ]})},
      children:[
        new Paragraph({ alignment:AlignmentType.CENTER, spacing:{ before:0, after:80 },
          children:[ new TextRun({ text:"Moraine Solar Energy Center", bold:true, font:"Arial", size:36, color:BLUE }) ]
        }),
        new Paragraph({ alignment:AlignmentType.CENTER, spacing:{ before:0, after:200 },
          children:[ new TextRun({ text:"Daily Environmental Compliance Report", font:"Arial", size:26, color:MID_BLUE }) ]
        }),
        infoTable(log.longDate, contractors, log.activePhase),
        spacer(200),

        heading1("1.  Weather Conditions"),
        spacer(60),
        twoColTable(weatherRows),
        spacer(200),

        heading1("2.  Inspection Summary"),
        spacer(60),
        heading2("Contractor Activities"),
        ...buildContractorActivities(log.crews),
        spacer(100),
        heading2("Field Observations"),
        body(`EI attended the morning safety meeting/tailgate at ${crewStart}, then conducted inspection of all active tree felling areas throughout the day. The following contractor work items were observed:`),
        spacer(40),
        ...buildFieldObservations(log, photos.length),
        spacer(40),
        body("All work observed was conducted within staked Limits of Disturbance (LOD). Wetland and stream buffer boundaries remained intact and undisturbed during the inspection period."),
        spacer(200),

        heading1("3.  Compliance Issues"),
        spacer(60),
        heading2("Agency Inspections"),
        body(agencyText),
        spacer(100),
        heading2("Non-Compliance Observations"),
        complianceTable(log.complianceIssues || []),
        spacer(60),
        body("Compliance Level Reference: Level 1 — Observation | Level 2 — Corrective Action | Level 3 — Non-Compliance | Level 4 — Stop Work Order",
          { italics:true, color:"666666", size:18 }),
        spacer(100),
        heading2("Landowner / Public Interactions"),
        body(landownerText),
        spacer(100),
        heading2("T&E Species / Unanticipated Discoveries"),
        body(rteText),
        spacer(200),

        heading1("4.  General Communication to Contractors"),
        spacer(60),
        ...buildGenComms(log.genComms),
        spacer(200),

        heading1("5.  24-Hour Look Ahead"),
        spacer(60),
        ...buildLookahead(log.lookahead),
        spacer(200),

        heading1("6.  Photo Log"),
        spacer(60),
        body(`The following photographs were taken during the inspection on ${log.shortDate}.`),
        spacer(100),
        ...(photos.length > 0
          ? [photoTable(photos)]
          : [body("No photographs available for this inspection period.")]),
        spacer(300),

        new Paragraph({
          children:[ new TextRun({ text:"Report Certification", bold:true, font:"Arial", size:22, color:BLUE }) ],
          spacing:{ before:0, after:80 },
          border:{ bottom:{ style:BorderStyle.SINGLE, size:6, color:BLUE, space:4 } }
        }),
        spacer(60),
        body("I certify that the information contained in this Daily Environmental Compliance Report is accurate and complete to the best of my knowledge, and that all observations were conducted in accordance with the approved Environmental Monitoring Plan."),
        spacer(120),
        certTable(log.shortDate),
      ]
    }]
  });

  // Filename: MM-DD-YYYY_Moraine_Solar-Daily_Inspection_Report.docx
  const [fy, fm, fd] = app.reportDate.split('-');
  const outName = `${fm}-${fd}-${fy}_Moraine_Solar-Daily_Inspection_Report.docx`;
  const outPath = path.join(outDir, outName);
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buf);
  console.log(`\nReport written: ${outPath}`);
  console.log("Remember: proofread before distribution.");
}

main().catch(err => { console.error(err); process.exit(1); });
