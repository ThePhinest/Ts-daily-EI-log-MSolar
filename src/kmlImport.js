// ═══════════════════════════════════════════
// KML / KMZ IMPORT — B2 In-App Tracker Map (Session 1 / Stage 1.3)
// ═══════════════════════════════════════════
//
// Module-scope (ESM import/export) wrapper around @tmcw/togeojson +
// JSZip. Returns a uniform parse result that the import-inspection
// modal (Stage 1.5) and the layer mount logic (Stage 1.4) both read.
//
// Library choices locked in 2026-05-14 plan session via background
// research subagent:
//   - @tmcw/togeojson@^7.1.2 (kmlWithFolders preserves the folder tree;
//     auto-decodes aabbggrr color order; resolves StyleMap to normal)
//   - jszip@3.10.1 (already a transitive of docx — deduped)
//
// Drops silently: <NetworkLink>, <Model>, <ScreenOverlay>. None of these
// matter for regulatory / surveyor KMLs.
//
// Errors are wrapped + emitted via window._reportError so the β.1
// reporter pipe (errorReporter.js) lands them in Firestore for the β.2
// Discord digest planned for B2 Session 3.

import { kmlWithFolders } from '@tmcw/togeojson';
import JSZip from 'jszip';

// 11-color palette used as fallback when a KML feature has no fill/stroke.
// Stable order means feature `_paletteIdx` is reproducible — folder N
// always shows in palette[N % 11] when no style is provided.
const KML_PALETTE = [
  '#C9A84C', // amber (matches current Mapbox default)
  '#4A90E2', // blue (streams / hydro)
  '#27AE60', // green (vegetation / wetlands)
  '#E67E22', // orange
  '#9B59B6', // purple
  '#E74C3C', // red
  '#16A085', // teal
  '#F39C12', // gold
  '#7F8C8D', // gray
  '#2ECC71', // bright green
  '#D35400'  // burnt orange
];

function _walkChildren(children, folderPath, paletteIdx, collector){
  for(const child of children){
    if(!child) continue;
    if(child.type === 'folder'){
      const name = (child.meta && child.meta.name) || '(unnamed folder)';
      const nextPath = folderPath ? folderPath + ' / ' + name : name;
      const nextIdx = collector.folders.length;
      collector.folders.push({ path: nextPath, name, featureCount: 0 });
      _walkChildren(child.children || [], nextPath, nextIdx % KML_PALETTE.length, collector);
    } else {
      // Feature
      if(!child.geometry) continue;
      child.properties = child.properties || {};
      child.properties._folderPath = folderPath || '';
      child.properties._paletteIdx = paletteIdx;
      collector.features.push(child);
      // Count style coverage: feature has explicit fill or stroke?
      const hasFill = typeof child.properties.fill === 'string';
      const hasStroke = typeof child.properties.stroke === 'string';
      if(hasFill || hasStroke) collector.styled++;
      // Bump folder count
      const lastFolder = collector.folders.find(f => f.path === folderPath);
      if(lastFolder) lastFolder.featureCount++;
    }
  }
}

function _computeBounds(features){
  if(features.length === 0) return null;
  let minLng=Infinity, minLat=Infinity, maxLng=-Infinity, maxLat=-Infinity;
  const walkCoords = (coords) => {
    if(typeof coords[0] === 'number'){
      const lng = coords[0], lat = coords[1];
      if(lng < minLng) minLng = lng;
      if(lat < minLat) minLat = lat;
      if(lng > maxLng) maxLng = lng;
      if(lat > maxLat) maxLat = lat;
    } else {
      for(const c of coords) walkCoords(c);
    }
  };
  for(const f of features){
    if(f.geometry && f.geometry.coordinates) walkCoords(f.geometry.coordinates);
  }
  if(!isFinite(minLng)) return null;
  return { minLng, minLat, maxLng, maxLat };
}

function _classifyGeometry(features){
  const out = { polygons: 0, lines: 0, points: 0, other: 0 };
  for(const f of features){
    const t = f.geometry && f.geometry.type;
    if(t === 'Polygon' || t === 'MultiPolygon') out.polygons++;
    else if(t === 'LineString' || t === 'MultiLineString') out.lines++;
    else if(t === 'Point' || t === 'MultiPoint') out.points++;
    else out.other++;
  }
  return out;
}

function _parseKmlString(kmlText, sourceFilename){
  const errors = [];
  let xmlDoc;
  try {
    xmlDoc = new DOMParser().parseFromString(kmlText, 'text/xml');
    const parseError = xmlDoc.querySelector('parsererror');
    if(parseError){
      throw new Error('XML parse error: ' + (parseError.textContent || 'unknown'));
    }
  } catch(e){
    errors.push({ stage: 'xml-parse', message: e.message });
    if(typeof window !== 'undefined' && typeof window._reportError === 'function'){
      window._reportError({ type: 'kml-import-error', filename: sourceFilename, stage: 'xml-parse', error: e.message });
    }
    throw e;
  }
  let root;
  try {
    root = kmlWithFolders(xmlDoc, { skipNullGeometry: true });
  } catch(e){
    errors.push({ stage: 'togeojson', message: e.message });
    if(typeof window !== 'undefined' && typeof window._reportError === 'function'){
      window._reportError({ type: 'kml-import-error', filename: sourceFilename, stage: 'togeojson', error: e.message });
    }
    throw e;
  }
  const collector = { features: [], folders: [], styled: 0 };
  // Root-level features (outside any folder) get folderPath='' and paletteIdx=0.
  _walkChildren(root.children || [], '', 0, collector);
  // If everything was at root-level (no folders at all), add a synthetic root folder
  // so the layer panel always has something to toggle.
  if(collector.folders.length === 0 && collector.features.length > 0){
    collector.folders.push({ path: '', name: sourceFilename.replace(/\.[^.]+$/, ''), featureCount: collector.features.length });
  }
  const geomCounts = _classifyGeometry(collector.features);
  const bounds = _computeBounds(collector.features);
  return {
    sourceFilename,
    features: collector.features,
    folders: collector.folders,
    geomCounts,
    bounds,
    styleCoverage: { styled: collector.styled, total: collector.features.length },
    errors
  };
}

// Parse a plain .kml File. Returns { features, folders, geomCounts, bounds,
// styleCoverage, errors, sourceFilename, fileSize }.
export async function parseKmlFile(file){
  if(!file) throw new Error('No file provided');
  const fileSize = file.size;
  const sourceFilename = file.name || 'untitled.kml';
  let text;
  try {
    text = await file.text();
  } catch(e){
    if(typeof window !== 'undefined' && typeof window._reportError === 'function'){
      window._reportError({ type: 'kml-import-error', filename: sourceFilename, stage: 'file-read', error: e.message });
    }
    throw new Error('Failed to read file: ' + e.message);
  }
  const parsed = _parseKmlString(text, sourceFilename);
  return { ...parsed, fileSize };
}

// Parse a .kmz File (zip archive containing one or more .kml + embedded
// images). Returns the same shape as parseKmlFile plus
//   embeddedIcons: Map<archivePath, blobUrl>
// Caller is responsible for calling URL.revokeObjectURL on each blobUrl
// when the layer unmounts (Stage 1.4 layer-architecture concern).
export async function parseKmzFile(file){
  if(!file) throw new Error('No file provided');
  const fileSize = file.size;
  const sourceFilename = file.name || 'untitled.kmz';
  let zip;
  try {
    const buf = await file.arrayBuffer();
    zip = await JSZip.loadAsync(buf);
  } catch(e){
    if(typeof window !== 'undefined' && typeof window._reportError === 'function'){
      window._reportError({ type: 'kml-import-error', filename: sourceFilename, stage: 'kmz-unzip', error: e.message });
    }
    throw new Error('Failed to unzip KMZ: ' + e.message);
  }
  // Find the first .kml in the archive (KMZ spec says it's named doc.kml
  // by convention but Google Earth tolerates any *.kml at any depth).
  let kmlEntry = zip.file(/\.kml$/i)[0];
  if(!kmlEntry){
    const e = new Error('No .kml file found inside .kmz archive');
    if(typeof window !== 'undefined' && typeof window._reportError === 'function'){
      window._reportError({ type: 'kml-import-error', filename: sourceFilename, stage: 'kmz-no-kml', error: e.message });
    }
    throw e;
  }
  const kmlText = await kmlEntry.async('string');
  const parsed = _parseKmlString(kmlText, sourceFilename);
  // Pull out embedded icons (PNG/JPG/SVG) for map.addImage() registration.
  const embeddedIcons = new Map();
  const iconEntries = zip.file(/\.(png|jpe?g|gif|svg)$/i);
  for(const entry of iconEntries){
    try {
      const blob = await entry.async('blob');
      const url = URL.createObjectURL(blob);
      embeddedIcons.set(entry.name, url);
    } catch(e){
      parsed.errors.push({ stage: 'icon-extract', path: entry.name, message: e.message });
    }
  }
  return { ...parsed, fileSize, embeddedIcons, kmlText };
}

// Convenience: branch on file extension. Used by the import button handler.
export async function parseKmlOrKmzFile(file){
  const name = (file && file.name) || '';
  if(/\.kmz$/i.test(name)) return parseKmzFile(file);
  return parseKmlFile(file);
}

// Window exposure for non-module callers (maps.js, modal handlers).
if(typeof window !== 'undefined'){
  window.parseKmlFile = parseKmlFile;
  window.parseKmzFile = parseKmzFile;
  window.parseKmlOrKmzFile = parseKmlOrKmzFile;
  window.KML_PALETTE = KML_PALETTE;
}
