const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Repository root is one level above _uploader
const REPO_ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(REPO_ROOT, '_models');
const IMAGES_MODELS_DIR = path.join(REPO_ROOT, 'images', 'models');

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Serve repository /images so existing model thumbnails & gallery WebP files display in the UI
app.use('/images', express.static(path.join(REPO_ROOT, 'images')));

app.get('/columns', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'columns.html'));
});

/**
 * Helper: Slugify a string into a clean SEO shortname
 */
function toShortname(input) {
  return String(input || '')
    .toLowerCase()
    .split('|')[0]
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Helper: Extract a clean 11-character YouTube video ID if a full URL is provided
 */
function cleanYoutubeId(raw) {
  const str = String(raw || '').trim();
  if (!str) return '';
  const match = str.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return match ? match[1] : str;
}

/**
 * Helper: Escape a string for safe double-quoted YAML scalar output
 */
function yamlQuote(str) {
  const s = String(str ?? '').trim();
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Unquote a YAML scalar value
 */
function yamlUnquote(val) {
  const s = String(val || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s;
}

/**
 * Helper: Split a title containing "|" at the first pipe into { title, extendedTitle }
 */
function splitTitleOnFirstPipe(rawTitle) {
  const full = String(rawTitle || '').trim();
  const pipeIdx = full.indexOf('|');
  if (pipeIdx === -1) {
    return { title: full, extendedTitle: '' };
  }
  return {
    title: full.slice(0, pipeIdx).trim(),
    extendedTitle: full.slice(pipeIdx + 1).trim()
  };
}

/**
 * Parse a Jekyll _models/*.md file into structured front matter + description + printSettings
 */
function parseModelMarkdown(filename) {
  const fullPath = path.join(MODELS_DIR, filename);
  const raw = fs.readFileSync(fullPath, 'utf8');
  const slug = filename.replace(/\.md$/, '');

  const result = {
    filename,
    slug,
    title: slug,
    extended_title: '',
    tagline: '',
    shortname: slug,
    category: 'useful-prints',
    fan_favorite: false,
    hidden: false,
    thumbnail_image: '',
    cover_image: '',
    gallery_images: [],
    detailed_images: [],
    animation: '',
    tags: [],
    downloads: {
      makerworld: '',
      printables: '',
      thangs: '',
      cults3d: ''
    },
    youtube_shorts: [],
    youtube_videos: [],
    youtube_id: '',
    products: [],
    description: '',
    printSettings: ''
  };

  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) {
    result.description = raw.trim();
    return result;
  }

  const fmText = fmMatch[1];
  const bodyText = fmMatch[2] || '';

  // Line-by-line YAML parser for our model front matter schema
  const lines = fmText.split(/\r?\n/);
  let currentKey = null;
  let hasExplicitExtendedTitle = false;

  for (const line of lines) {
    // Nested item under products list (e.g. "  - name: ..." or "    url: ...")
    if (currentKey === 'products') {
      const prodNewItemMatch = line.match(/^\s+-\s+([a-zA-Z0-9_]+):\s*(.*)$/);
      if (prodNewItemMatch) {
        const itemObj = {};
        itemObj[prodNewItemMatch[1]] = yamlUnquote(prodNewItemMatch[2]);
        result.products.push(itemObj);
        continue;
      }
      const prodPropMatch = line.match(/^\s+([a-zA-Z0-9_]+):\s*(.*)$/);
      if (prodPropMatch && result.products.length > 0) {
        result.products[result.products.length - 1][prodPropMatch[1]] = yamlUnquote(prodPropMatch[2]);
        continue;
      }
    }

    // List item under gallery_images, detailed_images, tags, youtube_shorts, or youtube_videos
    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (
      listMatch &&
      (currentKey === 'gallery_images' ||
        currentKey === 'detailed_images' ||
        currentKey === 'tags' ||
        currentKey === 'youtube_shorts' ||
        currentKey === 'youtube_videos')
    ) {
      result[currentKey].push(yamlUnquote(listMatch[1]));
      continue;
    }

    // Nested dictionary item under downloads
    const nestedMatch = line.match(/^\s+([a-zA-Z0-9_]+):\s*(.*)$/);
    if (nestedMatch && currentKey === 'downloads') {
      const subKey = nestedMatch[1];
      const subVal = yamlUnquote(nestedMatch[2]);
      result.downloads[subKey] = subVal;
      continue;
    }

    // Top-level key: value
    const kvMatch = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const rawVal = kvMatch[2].trim();
      currentKey = key;

      if (key === 'extended_title') {
        hasExplicitExtendedTitle = true;
      }

      if (
        key === 'gallery_images' ||
        key === 'detailed_images' ||
        key === 'tags' ||
        key === 'youtube_shorts' ||
        key === 'youtube_videos' ||
        key === 'products'
      ) {
        if (rawVal === '[]') {
          result[key] = [];
        }
      } else if (key === 'downloads') {
        // subsequent indented lines populate downloads
      } else if (key === 'hidden') {
        const unquoted = yamlUnquote(rawVal).toLowerCase();
        result.hidden = unquoted === 'true' || unquoted === 'yes';
      } else if (key === 'fan_favorite') {
        const unquoted = yamlUnquote(rawVal).toLowerCase();
        result.fan_favorite = unquoted === 'true' || unquoted === 'yes';
      } else if (key in result) {
        result[key] = yamlUnquote(rawVal);
      }
    }
  }

  // If extended_title wasn't explicitly set in front matter and title has "|", split it automatically
  if (!hasExplicitExtendedTitle && result.title && result.title.includes('|')) {
    const split = splitTitleOnFirstPipe(result.title);
    result.title = split.title;
    result.extended_title = split.extendedTitle;
  }

  // Backwards compatibility: if only youtube_id is present and youtube_shorts/youtube_videos are empty, include it
  if (
    result.youtube_shorts.length === 0 &&
    result.youtube_videos.length === 0 &&
    result.youtube_id
  ) {
    result.youtube_videos = [result.youtube_id];
  }

  // Split Markdown body into description and ### Recommended Print Settings (if present)
  const settingsHeaderRegex = /\n?(###\s+Recommended Print Settings\s*\r?\n[\s\S]*)$/i;
  const settingsMatch = bodyText.match(settingsHeaderRegex);
  if (settingsMatch) {
    const fullSettingsBlock = settingsMatch[1].trim();
    result.description = bodyText.slice(0, settingsMatch.index).trim();
    result.printSettings = fullSettingsBlock
      .replace(/^###\s+Recommended Print Settings\s*\r?\n+/i, '')
      .trim();
  } else {
    result.description = bodyText.trim();
    result.printSettings = '';
  }

  return result;
}

/**
 * Decode a data:image/webp;base64,... string into a Buffer
 */
function decodeBase64WebP(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') {
    throw new Error('Missing image data URL');
  }
  const base64Part = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  return Buffer.from(base64Part, 'base64');
}

/**
 * GET /api/models — List all existing models in _models/ with full metadata
 */
app.get('/api/models', (req, res) => {
  try {
    if (!fs.existsSync(MODELS_DIR)) {
      return res.json({ models: [] });
    }
    const models = fs
      .readdirSync(MODELS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((filename) => parseModelMarkdown(filename));
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/models/:slug — Fetch a single model's full data for editing
 */
app.get('/api/models/:slug', (req, res) => {
  try {
    const slug = String(req.params.slug || '').replace(/\.md$/, '');
    const filename = `${slug}.md`;
    const fullPath = path.join(MODELS_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: `Model "${slug}" not found in _models/.` });
    }
    const model = parseModelMarkdown(filename);
    res.json({ model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Normalize an array or comma-separated string of YouTube URLs/IDs into clean 11-char IDs
 */
function normalizeYoutubeIdList(input) {
  const rawList = Array.isArray(input)
    ? input
    : String(input || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  const seen = new Set();
  const out = [];
  rawList.forEach((item) => {
    const id = cleanYoutubeId(item);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  });
  return out;
}

/**
 * Download an animated GIF from media.printables.com and convert it to a looping MP4
 * (the model page plays `animation` in a <video> tag). Returns the web path.
 */
function convertPrintablesGifToLoopMp4(gifUrl, shortname, modelImageDir) {
  const parsed = new URL(String(gifUrl));
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'media.printables.com') {
    throw new Error('Animation URL must be on media.printables.com');
  }
  const tmpGif = path.join(os.tmpdir(), `printables-anim-${Date.now()}-${process.pid}.gif`);
  const mp4Filename = `3d-model-${shortname}-loop.mp4`;
  try {
    execFileSync('curl', ['-sSfL', '-m', '60', '-o', tmpGif, parsed.href], { stdio: 'ignore' });
    execFileSync(
      'ffmpeg',
      [
        '-loglevel', 'error', '-y', '-i', tmpGif,
        '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v', 'libx264', '-crf', '23', '-an',
        path.join(modelImageDir, mp4Filename)
      ],
      { stdio: 'ignore' }
    );
  } finally {
    try { fs.unlinkSync(tmpGif); } catch (e) { /* ignore */ }
  }
  return `/images/models/${shortname}/${mp4Filename}`;
}

/**
 * Shared handler for creating or updating a model
 */
function saveAndDeployModel(req, res) {
  try {
    const {
      originalSlug = null,
      title,
      extendedTitle = '',
      extended_title = '',
      tagline = '',
      shortname: rawShortname,
      category = 'useful-prints',
      fan_favorite = false,
      fanFavorite = false,
      hidden = false,
      description = '',
      printSettings = '',
      tags = '',
      youtubeShorts = [],
      youtubeVideos = [],
      youtubeId = '',
      products = null,
      downloads = {},
      mainImage = null,
      thumbImage = null,
      galleryImages = null,
      detailedImages = null,
      existingCoverImage = '',
      existingThumbImage = '',
      existingGalleryImages = [],
      existingDetailedImages = [],
      existingAnimation = '',
      animationUrl = '',
      autoDeploy = true
    } = req.body;

    const isEdit = Boolean(originalSlug);

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'Model Name (title) is required.' });
    }

    const cleanTitle = String(title).trim();
    const resolvedExtendedTitle = String(extendedTitle || extended_title || '').trim();
    const resolvedTagline = String(tagline || '').trim();

    const shortname = toShortname(rawShortname || cleanTitle);
    if (!shortname) {
      return res.status(400).json({ error: 'Could not derive a valid shortname slug.' });
    }

    // Require either new mainImage+thumbImage OR existingCoverImage+existingThumbImage when editing
    if (!mainImage && !existingCoverImage) {
      return res.status(400).json({
        error: 'At least one image must be provided to generate the 1200x1200 main and 600x600 thumbnail WebP files.'
      });
    }

    // 1. Ensure /images/models/[model-shortname]/ and /_models/ exist
    const modelImageDir = path.join(IMAGES_MODELS_DIR, shortname);
    fs.mkdirSync(modelImageDir, { recursive: true });
    fs.mkdirSync(MODELS_DIR, { recursive: true });

    const savedFiles = [];

    // 2. Main Showcase Image (1200x1200px): 3d-model-[shortname]-main.webp
    let mainWebPath = existingCoverImage || `/images/models/${shortname}/3d-model-${shortname}-main.webp`;
    if (mainImage && mainImage.startsWith('data:image/')) {
      const mainFilename = `3d-model-${shortname}-main.webp`;
      const mainDiskPath = path.join(modelImageDir, mainFilename);
      mainWebPath = `/images/models/${shortname}/${mainFilename}`;
      fs.writeFileSync(mainDiskPath, decodeBase64WebP(mainImage));
      savedFiles.push(mainWebPath);
    }

    // 3. Model Thumbnail (600x600px): 3d-model-[shortname]-thumb.webp
    let thumbWebPath = existingThumbImage || `/images/models/${shortname}/3d-model-${shortname}-thumb.webp`;
    if (thumbImage && thumbImage.startsWith('data:image/')) {
      const thumbFilename = `3d-model-${shortname}-thumb.webp`;
      const thumbDiskPath = path.join(modelImageDir, thumbFilename);
      thumbWebPath = `/images/models/${shortname}/${thumbFilename}`;
      fs.writeFileSync(thumbDiskPath, decodeBase64WebP(thumbImage));
      savedFiles.push(thumbWebPath);
    }

    // 4. Additional Gallery Images (1000x1000px): 3d-model-[shortname]-angle1.webp, angle2.webp, ...
    // Each entry in galleryImages can be either a new base64 dataUrl OR an existing /images/... path
    const galleryWebPaths = [];
    const inputGallery = Array.isArray(galleryImages) ? galleryImages : existingGalleryImages;
    if (Array.isArray(inputGallery)) {
      inputGallery.forEach((item, idx) => {
        if (!item) return;
        const angleFilename = `3d-model-${shortname}-angle${idx + 1}.webp`;
        const angleDiskPath = path.join(modelImageDir, angleFilename);
        const angleWebPath = `/images/models/${shortname}/${angleFilename}`;

        if (typeof item === 'string' && item.startsWith('data:image/')) {
          fs.writeFileSync(angleDiskPath, decodeBase64WebP(item));
          galleryWebPaths.push(angleWebPath);
          savedFiles.push(angleWebPath);
        } else if (typeof item === 'string') {
          // Existing path kept
          galleryWebPaths.push(item);
        }
      });
    }

    // 4b. Detailed View Images (1000x1000px): 3d-model-[shortname]-detail1.webp, detail2.webp, ...
    const detailedWebPaths = [];
    const inputDetailed = Array.isArray(detailedImages) ? detailedImages : existingDetailedImages;
    if (Array.isArray(inputDetailed)) {
      inputDetailed.forEach((item, idx) => {
        if (!item) return;
        const detailFilename = `3d-model-${shortname}-detail${idx + 1}.webp`;
        const detailDiskPath = path.join(modelImageDir, detailFilename);
        const detailWebPath = `/images/models/${shortname}/${detailFilename}`;

        if (typeof item === 'string' && item.startsWith('data:image/')) {
          fs.writeFileSync(detailDiskPath, decodeBase64WebP(item));
          detailedWebPaths.push(detailWebPath);
          savedFiles.push(detailWebPath);
        } else if (typeof item === 'string') {
          detailedWebPaths.push(item);
        }
      });
    }

    // 5. Parse comma-separated tags
    const parsedTags = Array.isArray(tags)
      ? tags.map((t) => String(t).trim()).filter(Boolean)
      : String(tags || '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);

    const parsedShorts = normalizeYoutubeIdList(youtubeShorts);
    let parsedVideos = normalizeYoutubeIdList(youtubeVideos).filter(
      (id) => !parsedShorts.includes(id)
    );
    const singleFallbackId = cleanYoutubeId(youtubeId);
    if (parsedShorts.length === 0 && parsedVideos.length === 0 && singleFallbackId) {
      parsedVideos = [singleFallbackId];
    }
    const primaryYoutubeId = parsedShorts[0] || parsedVideos[0] || '';

    // 6. Build Jekyll Markdown with YAML Front Matter
    const yamlLines = [
      '---',
      `title: ${yamlQuote(cleanTitle)}`,
      `extended_title: ${yamlQuote(resolvedExtendedTitle)}`,
      `tagline: ${yamlQuote(resolvedTagline)}`,
      `shortname: ${yamlQuote(shortname)}`,
      `category: ${yamlQuote(category || 'useful-prints')}`,
      `fan_favorite: ${Boolean(fan_favorite || fanFavorite)}`,
      `hidden: ${Boolean(hidden)}`,
      `thumbnail_image: ${yamlQuote(thumbWebPath)}`,
      `cover_image: ${yamlQuote(mainWebPath)}`
    ];

    if (galleryWebPaths.length > 0) {
      yamlLines.push('gallery_images:');
      galleryWebPaths.forEach((p) => {
        yamlLines.push(`  - ${yamlQuote(p)}`);
      });
    } else {
      yamlLines.push('gallery_images: []');
    }

    if (detailedWebPaths.length > 0) {
      yamlLines.push('detailed_images:');
      detailedWebPaths.forEach((p) => {
        yamlLines.push(`  - ${yamlQuote(p)}`);
      });
    } else {
      yamlLines.push('detailed_images: []');
    }

    if (existingAnimation) {
      yamlLines.push(`animation: ${yamlQuote(existingAnimation)}`);
    }

    if (parsedTags.length > 0) {
      yamlLines.push('tags:');
      parsedTags.forEach((t) => {
        yamlLines.push(`  - ${yamlQuote(t)}`);
      });
    } else {
      yamlLines.push('tags: []');
    }

    yamlLines.push('downloads:');
    yamlLines.push(`  makerworld: ${yamlQuote(downloads.makerworld || '')}`);
    yamlLines.push(`  printables: ${yamlQuote(downloads.printables || '')}`);
    yamlLines.push(`  thangs: ${yamlQuote(downloads.thangs || '')}`);
    yamlLines.push(`  cults3d: ${yamlQuote(downloads.cults3d || '')}`);

    if (parsedShorts.length > 0) {
      yamlLines.push('youtube_shorts:');
      parsedShorts.forEach((id) => {
        yamlLines.push(`  - ${yamlQuote(id)}`);
      });
    } else {
      yamlLines.push('youtube_shorts: []');
    }

    if (parsedVideos.length > 0) {
      yamlLines.push('youtube_videos:');
      parsedVideos.forEach((id) => {
        yamlLines.push(`  - ${yamlQuote(id)}`);
      });
    } else {
      yamlLines.push('youtube_videos: []');
    }

    yamlLines.push(`youtube_id: ${yamlQuote(primaryYoutubeId)}`);

    let finalProducts;
    if (Array.isArray(products)) {
      finalProducts = products.filter(function (p) {
        return p && ((p.name && p.name.trim()) || (p.url && p.url.trim()));
      });
    } else if (isEdit && originalSlug) {
      const origFile = `${originalSlug}.md`;
      const origPath = path.join(MODELS_DIR, origFile);
      if (fs.existsSync(origPath)) {
        const parsedOrig = parseModelMarkdown(origFile);
        if (Array.isArray(parsedOrig.products) && parsedOrig.products.length > 0) {
          finalProducts = parsedOrig.products;
        }
      }
    }

    if (Array.isArray(finalProducts) && finalProducts.length > 0) {
      yamlLines.push('products:');
      finalProducts.forEach((p) => {
        yamlLines.push(`  - name: ${yamlQuote(p.name || p.title || '')}`);
        if (p.category) yamlLines.push(`    category: ${yamlQuote(p.category)}`);
        if (p.badge) yamlLines.push(`    badge: ${yamlQuote(p.badge)}`);
        if (p.description) yamlLines.push(`    description: ${yamlQuote(p.description)}`);
        yamlLines.push(`    url: ${yamlQuote(p.url || '')}`);
        if (p.cta) yamlLines.push(`    cta: ${yamlQuote(p.cta)}`);
      });
    }

    yamlLines.push('---');
    yamlLines.push('');

    const bodySections = [];
    if (String(description).trim()) {
      bodySections.push(String(description).trim());
    }
    if (String(printSettings).trim()) {
      const settingsText = String(printSettings).trim();
      if (/^#{1,4}\s+/m.test(settingsText)) {
        bodySections.push(settingsText);
      } else {
        bodySections.push(`### Recommended Print Settings\n\n${settingsText}`);
      }
    }

    const markdownContent = yamlLines.join('\n') + bodySections.join('\n\n') + '\n';

    // Determine target markdown filename (if editing, preserve originalSlug filename unless shortname was explicitly changed)
    const targetSlug = isEdit && originalSlug ? originalSlug : shortname;
    const mdFilename = `${targetSlug}.md`;
    const mdDiskPath = path.join(MODELS_DIR, mdFilename);
    const mdWebPath = `/_models/${mdFilename}`;

    fs.writeFileSync(mdDiskPath, markdownContent, 'utf8');
    savedFiles.push(mdWebPath);

    // 7. Auto-Deploy: git add ., git commit -m "Add/Update [model name]", git push
    const gitLog = [];
    let deployed = false;
    let gitError = null;

    if (autoDeploy !== false) {
      try {
        execFileSync('git', ['add', '.'], { cwd: REPO_ROOT, encoding: 'utf8' });
        gitLog.push('$ git add .');

        const actionVerb = isEdit ? 'Update' : 'Add';
        const commitMessage = `${actionVerb} ${cleanTitle}`;
        const commitOut = execFileSync('git', ['commit', '-m', commitMessage], {
          cwd: REPO_ROOT,
          encoding: 'utf8'
        });
        gitLog.push(`$ git commit -m "${commitMessage}"\n${commitOut.trim()}`);

        try {
          const pushOut = execFileSync('git', ['push'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
          });
          gitLog.push(`$ git push\n${(pushOut || 'Pushed to remote origin.').trim()}`);
        } catch (pushErr) {
          // If remote has newer commits, rebase automatically and push again
          execFileSync('git', ['pull', '--rebase'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
          });
          const retryPushOut = execFileSync('git', ['push'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
          });
          gitLog.push(`$ git pull --rebase && git push\n${(retryPushOut || 'Rebased and pushed to remote origin.').trim()}`);
        }
        deployed = true;
      } catch (gitErr) {
        const stderr = gitErr.stderr ? gitErr.stderr.toString() : '';
        const stdout = gitErr.stdout ? gitErr.stdout.toString() : '';
        gitError = (stderr || stdout || gitErr.message).trim();
        gitLog.push(`Git warning/error: ${gitError}`);
      }
    }

    return res.json({
      success: true,
      isEdit,
      slug: targetSlug,
      shortname,
      title: cleanTitle,
      extendedTitle: resolvedExtendedTitle,
      tagline: resolvedTagline,
      hidden: Boolean(hidden),
      markdownPath: mdWebPath,
      markdownContent,
      savedFiles,
      deployed,
      gitError,
      gitLog: gitLog.join('\n\n')
    });
  } catch (err) {
    console.error('Upload/Edit error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

app.post('/api/models', saveAndDeployModel);
app.put('/api/models/:slug', (req, res) => {
  req.body.originalSlug = req.params.slug;
  return saveAndDeployModel(req, res);
});

/**
 * PATCH /api/models/:slug/visibility — Quick toggle for hidden: true / false
 */
app.patch('/api/models/:slug/visibility', (req, res) => {
  try {
    const slug = String(req.params.slug || '').replace(/\.md$/, '');
    const filename = `${slug}.md`;
    const fullPath = path.join(MODELS_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: `Model "${slug}" not found in _models/.` });
    }
    const existing = parseModelMarkdown(filename);
    const nextHidden = typeof req.body.hidden === 'boolean' ? req.body.hidden : !existing.hidden;

    req.body = {
      originalSlug: slug,
      title: existing.title,
      extendedTitle: existing.extended_title,
      tagline: existing.tagline,
      shortname: existing.shortname,
      category: existing.category,
      hidden: nextHidden,
      description: existing.description,
      printSettings: existing.printSettings,
      tags: existing.tags,
      youtubeShorts: existing.youtube_shorts,
      youtubeVideos: existing.youtube_videos,
      youtubeId: existing.youtube_id,
      products: existing.products,
      downloads: existing.downloads,
      existingCoverImage: existing.cover_image,
      existingThumbImage: existing.thumbnail_image,
      existingGalleryImages: existing.gallery_images,
      existingDetailedImages: existing.detailed_images,
      existingAnimation: existing.animation,
      autoDeploy: req.body.autoDeploy !== false
    };
    return saveAndDeployModel(req, res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Helper: Update the downloads section of a single _models/<slug>.md file in-place
 */
function updateModelDownloadsOnDisk(rawSlug, downloadsInput = {}) {
  const slug = String(rawSlug || '').replace(/\.md$/, '').trim();
  if (!slug) {
    throw new Error('Missing model slug.');
  }
  const filename = `${slug}.md`;
  const fullPath = path.join(MODELS_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Model "${slug}" not found in _models/.`);
  }

  const existing = parseModelMarkdown(filename);
  const nextDownloads = {
    makerworld:
      downloadsInput.makerworld !== undefined
        ? String(downloadsInput.makerworld || '').trim()
        : existing.downloads.makerworld || '',
    printables:
      downloadsInput.printables !== undefined
        ? String(downloadsInput.printables || '').trim()
        : existing.downloads.printables || '',
    thangs:
      downloadsInput.thangs !== undefined
        ? String(downloadsInput.thangs || '').trim()
        : existing.downloads.thangs || '',
    cults3d:
      downloadsInput.cults3d !== undefined
        ? String(downloadsInput.cults3d || '').trim()
        : existing.downloads.cults3d || ''
  };

  const downloadsYamlBlock = [
    'downloads:',
    `  makerworld: ${yamlQuote(nextDownloads.makerworld)}`,
    `  printables: ${yamlQuote(nextDownloads.printables)}`,
    `  thangs: ${yamlQuote(nextDownloads.thangs)}`,
    `  cults3d: ${yamlQuote(nextDownloads.cults3d)}`
  ].join('\n');

  const raw = fs.readFileSync(fullPath, 'utf8');
  const fmMatch = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?[\s\S]*)$/);
  if (fmMatch) {
    let fmBody = fmMatch[2];
    const dlBlockRegex = /^downloads:\r?\n(?:[ \t]+[a-zA-Z0-9_]+:.*(?:\r?\n|$))*/m;
    if (dlBlockRegex.test(fmBody)) {
      fmBody = fmBody.replace(dlBlockRegex, `${downloadsYamlBlock}\n`);
    } else {
      fmBody = `${fmBody.replace(/\s+$/, '')}\n${downloadsYamlBlock}`;
    }
    const updatedRaw = `${fmMatch[1]}${fmBody.replace(/\r?\n$/, '')}${fmMatch[3]}`;
    fs.writeFileSync(fullPath, updatedRaw, 'utf8');
  } else {
    throw new Error(`Model "${slug}" is missing valid YAML front matter.`);
  }

  return parseModelMarkdown(filename);
}

/**
 * Helper: Commit and push changes to Git repository
 */
function commitAndPushChanges(commitMessage) {
  const gitLog = [];
  let deployed = false;
  let gitError = null;

  try {
    execFileSync('git', ['add', '.'], { cwd: REPO_ROOT, encoding: 'utf8' });
    gitLog.push('$ git add .');

    const commitOut = execFileSync('git', ['commit', '-m', commitMessage], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    });
    gitLog.push(`$ git commit -m "${commitMessage}"\n${commitOut.trim()}`);

    try {
      const pushOut = execFileSync('git', ['push'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      gitLog.push(`$ git push\n${(pushOut || 'Pushed to remote origin.').trim()}`);
    } catch (pushErr) {
      execFileSync('git', ['pull', '--rebase'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const retryPushOut = execFileSync('git', ['push'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      gitLog.push(
        `$ git pull --rebase && git push\n${(retryPushOut || 'Rebased and pushed to remote origin.').trim()}`
      );
    }
    deployed = true;
  } catch (gitErr) {
    const stderr = gitErr.stderr ? gitErr.stderr.toString() : '';
    const stdout = gitErr.stdout ? gitErr.stdout.toString() : '';
    gitError = (stderr || stdout || gitErr.message).trim();
    gitLog.push(`Git warning/error: ${gitError}`);
  }

  return { deployed, gitError, gitLog: gitLog.join('\n\n') };
}

/**
 * PATCH /api/models/:slug/downloads — Update download links for a single model
 */
app.patch('/api/models/:slug/downloads', (req, res) => {
  try {
    const slug = String(req.params.slug || '').replace(/\.md$/, '');
    const updatedModel = updateModelDownloadsOnDisk(slug, req.body.downloads || {});
    const autoDeploy = req.body.autoDeploy !== false;

    let deployResult = { deployed: false, gitError: null, gitLog: '' };
    if (autoDeploy) {
      deployResult = commitAndPushChanges(`Update download links for ${updatedModel.title}`);
    }

    return res.json({
      success: true,
      slug: updatedModel.slug,
      model: updatedModel,
      ...deployResult
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/models/bulk-downloads — Update download links for multiple models at once
 */
app.post('/api/models/bulk-downloads', (req, res) => {
  try {
    const updates = Array.isArray(req.body.updates) ? req.body.updates : [];
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No model updates provided.' });
    }

    const updatedModels = [];
    for (const item of updates) {
      if (!item || !item.slug) continue;
      const updated = updateModelDownloadsOnDisk(item.slug, item.downloads || {});
      updatedModels.push(updated);
    }

    const autoDeploy = req.body.autoDeploy !== false;
    let deployResult = { deployed: false, gitError: null, gitLog: '' };
    if (autoDeploy && updatedModels.length > 0) {
      const msg =
        updatedModels.length === 1
          ? `Update download links for ${updatedModels[0].title}`
          : `Update download links for ${updatedModels.length} models`;
      deployResult = commitAndPushChanges(msg);
    }

    return res.json({
      success: true,
      updatedCount: updatedModels.length,
      models: updatedModels,
      ...deployResult
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Helper: Update multiple fields for a model directly on disk
 */
function updateModelFieldsOnDisk(slug, fields = {}) {
  const filename = `${String(slug || '').replace(/\.md$/, '')}.md`;
  const fullPath = path.join(MODELS_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Model "${slug}" not found in _models/.`);
  }

  const existing = parseModelMarkdown(filename);

  const cleanTitle = fields.title !== undefined ? String(fields.title || '').trim() : existing.title;
  const resolvedExtendedTitle = fields.extended_title !== undefined ? String(fields.extended_title || '').trim() : (fields.extendedTitle !== undefined ? String(fields.extendedTitle || '').trim() : existing.extended_title);
  const resolvedTagline = fields.tagline !== undefined ? String(fields.tagline || '').trim() : existing.tagline;
  const shortname = existing.shortname || slug;
  const category = fields.category !== undefined ? fields.category : existing.category;
  const fanFavorite = fields.fan_favorite !== undefined ? Boolean(fields.fan_favorite) : (fields.fanFavorite !== undefined ? Boolean(fields.fanFavorite) : Boolean(existing.fan_favorite));
  const hidden = fields.hidden !== undefined ? Boolean(fields.hidden) : existing.hidden;
  const thumbWebPath = existing.thumbnail_image;
  const mainWebPath = existing.cover_image;

  // Tags
  let parsedTags = existing.tags;
  if (fields.tags !== undefined) {
    parsedTags = Array.isArray(fields.tags)
      ? fields.tags.map((t) => String(t).trim()).filter(Boolean)
      : String(fields.tags || '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
  }

  // Downloads
  const downloads = fields.downloads !== undefined ? fields.downloads : existing.downloads;
  const dlMakerworld = downloads && downloads.makerworld !== undefined ? String(downloads.makerworld || '').trim() : (existing.downloads.makerworld || '');
  const dlPrintables = downloads && downloads.printables !== undefined ? String(downloads.printables || '').trim() : (existing.downloads.printables || '');
  const dlThangs = downloads && downloads.thangs !== undefined ? String(downloads.thangs || '').trim() : (existing.downloads.thangs || '');
  const dlCults3d = downloads && downloads.cults3d !== undefined ? String(downloads.cults3d || '').trim() : (existing.downloads.cults3d || '');

  // Products
  let finalProducts = existing.products;
  if (fields.products !== undefined) {
    if (Array.isArray(fields.products)) {
      finalProducts = fields.products.filter(function (p) {
        return p && ((p.name && p.name.trim()) || (p.url && p.url.trim()));
      });
    } else {
      finalProducts = [];
    }
  }

  // Description & Print Settings
  const description = fields.description !== undefined ? String(fields.description) : existing.description;
  const printSettings = fields.printSettings !== undefined ? String(fields.printSettings) : (fields.print_settings !== undefined ? String(fields.print_settings) : existing.printSettings);

  const yamlLines = [
    '---',
    `title: ${yamlQuote(cleanTitle)}`,
    `extended_title: ${yamlQuote(resolvedExtendedTitle)}`,
    `tagline: ${yamlQuote(resolvedTagline)}`,
    `shortname: ${yamlQuote(shortname)}`,
    `category: ${yamlQuote(category || 'useful-prints')}`,
    `fan_favorite: ${Boolean(fanFavorite)}`,
    `hidden: ${Boolean(hidden)}`,
    `thumbnail_image: ${yamlQuote(thumbWebPath)}`,
    `cover_image: ${yamlQuote(mainWebPath)}`
  ];

  if (Array.isArray(existing.gallery_images) && existing.gallery_images.length > 0) {
    yamlLines.push('gallery_images:');
    existing.gallery_images.forEach((p) => {
      yamlLines.push(`  - ${yamlQuote(p)}`);
    });
  } else {
    yamlLines.push('gallery_images: []');
  }

  if (Array.isArray(existing.detailed_images) && existing.detailed_images.length > 0) {
    yamlLines.push('detailed_images:');
    existing.detailed_images.forEach((p) => {
      yamlLines.push(`  - ${yamlQuote(p)}`);
    });
  } else {
    yamlLines.push('detailed_images: []');
  }

  if (existing.animation) {
    yamlLines.push(`animation: ${yamlQuote(existing.animation)}`);
  }

  if (parsedTags.length > 0) {
    yamlLines.push('tags:');
    parsedTags.forEach((t) => {
      yamlLines.push(`  - ${yamlQuote(t)}`);
    });
  } else {
    yamlLines.push('tags: []');
  }

  yamlLines.push('downloads:');
  yamlLines.push(`  makerworld: ${yamlQuote(dlMakerworld)}`);
  yamlLines.push(`  printables: ${yamlQuote(dlPrintables)}`);
  yamlLines.push(`  thangs: ${yamlQuote(dlThangs)}`);
  yamlLines.push(`  cults3d: ${yamlQuote(dlCults3d)}`);

  if (Array.isArray(existing.youtube_shorts) && existing.youtube_shorts.length > 0) {
    yamlLines.push('youtube_shorts:');
    existing.youtube_shorts.forEach((id) => {
      yamlLines.push(`  - ${yamlQuote(id)}`);
    });
  } else {
    yamlLines.push('youtube_shorts: []');
  }

  if (Array.isArray(existing.youtube_videos) && existing.youtube_videos.length > 0) {
    yamlLines.push('youtube_videos:');
    existing.youtube_videos.forEach((id) => {
      yamlLines.push(`  - ${yamlQuote(id)}`);
    });
  } else {
    yamlLines.push('youtube_videos: []');
  }

  yamlLines.push(`youtube_id: ${yamlQuote(existing.youtube_id || '')}`);

  if (Array.isArray(finalProducts) && finalProducts.length > 0) {
    yamlLines.push('products:');
    finalProducts.forEach((p) => {
      yamlLines.push(`  - name: ${yamlQuote(p.name || p.title || '')}`);
      if (p.category) yamlLines.push(`    category: ${yamlQuote(p.category)}`);
      if (p.badge) yamlLines.push(`    badge: ${yamlQuote(p.badge)}`);
      if (p.description) yamlLines.push(`    description: ${yamlQuote(p.description)}`);
      yamlLines.push(`    url: ${yamlQuote(p.url || '')}`);
      if (p.cta) yamlLines.push(`    cta: ${yamlQuote(p.cta)}`);
    });
  }

  yamlLines.push('---');
  yamlLines.push('');

  const bodySections = [];
  if (String(description).trim()) {
    bodySections.push(String(description).trim());
  }
  if (String(printSettings).trim()) {
    const settingsText = String(printSettings).trim();
    if (/^#{1,4}\s+/m.test(settingsText)) {
      bodySections.push(settingsText);
    } else {
      bodySections.push(`### Recommended Print Settings\n\n${settingsText}`);
    }
  }

  const markdownContent = yamlLines.join('\n') + bodySections.join('\n\n') + '\n';
  fs.writeFileSync(fullPath, markdownContent, 'utf8');

  return parseModelMarkdown(filename);
}

/**
 * POST /api/models/bulk-update — Update multiple editable fields across multiple models
 */
app.post('/api/models/bulk-update', (req, res) => {
  try {
    const updates = Array.isArray(req.body.updates) ? req.body.updates : [];
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No model updates provided.' });
    }

    const updatedModels = [];
    for (const item of updates) {
      if (!item || !item.slug) continue;
      const updated = updateModelFieldsOnDisk(item.slug, item.fields || {});
      updatedModels.push(updated);
    }

    const autoDeploy = req.body.autoDeploy !== false;
    let deployResult = { deployed: false, gitError: null, gitLog: '' };
    if (autoDeploy && updatedModels.length > 0) {
      const msg =
        updatedModels.length === 1
          ? `Update details for ${updatedModels[0].title}`
          : `Update details across ${updatedModels.length} models in table view`;
      deployResult = commitAndPushChanges(msg);
    }

    return res.json({
      success: true,
      updatedCount: updatedModels.length,
      models: updatedModels,
      ...deployResult
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Decode common HTML entities into plain characters
 */
function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&lsquo;|&rsquo;/gi, "'")
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Convert Printables HTML description into clean Jekyll-ready Markdown
 */
function htmlToMarkdown(html) {
  if (!html || typeof html !== 'string') return '';

  let md = html
    .replace(/\r\n/g, '\n')
    // Remove script/style tags if any
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Headings
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n')
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n\n')
    // Bold & Italic & Code
    .replace(/<(strong|b)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    // Links
    .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const cleanText = text.replace(/<[^>]+>/g, '').trim();
      return cleanText ? `[${cleanText}](${href})` : href;
    })
    // List items
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, item) => {
      const cleanItem = item
        .replace(/<\/?p[^>]*>/gi, ' ')
        .replace(/<br\s*\/?>/gi, ' ')
        .trim();
      return `\n- ${cleanItem}`;
    })
    .replace(/<\/?(ul|ol)[^>]*>/gi, '\n\n')
    // Paragraphs, line breaks, blockquotes, horizontal rules
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
    // Strip remaining HTML tags
    .replace(/<[^>]+>/g, '');

  md = decodeHtmlEntities(md);

  // Clean up excessive blank lines and trailing spaces
  return md
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Helper: Execute a GraphQL query against https://api.printables.com/graphql/
 */
async function queryPrintablesGraphQL(query, variables) {
  const response = await fetch('https://api.printables.com/graphql/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://www.printables.com',
      Referer: 'https://www.printables.com/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`Printables GraphQL HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * POST /api/import/printables — Fetch title, description, tags, Youtube ID, and images from a Printables URL
 */
app.post('/api/import/printables', async (req, res) => {
  try {
    const rawUrl = String(req.body.url || '').trim();
    if (!rawUrl) {
      return res.status(400).json({ error: 'Please provide a Printables model URL.' });
    }

    const idMatch = rawUrl.match(/printables\.com\/(?:[a-z]{2}\/)?model\/(\d+)/i);
    if (!idMatch) {
      return res.status(400).json({
        error: 'Could not find a numeric model ID in the URL (expected e.g. https://www.printables.com/model/123456-...).'
      });
    }

    const modelId = idMatch[1];
    let title = '';
    let summary = '';
    let descriptionHtml = '';
    let tags = [];
    let imageUrls = [];
    let categoryPath = [];

    // 1. Primary Method: Printables GraphQL API
    const fullQuery = `
      query GetPrintModel($id: ID!) {
        print(id: $id) {
          id
          name
          slug
          summary
          description
          tags {
            name
          }
          category {
            path {
              name
            }
          }
          image {
            filePath
          }
          images {
            filePath
            order
          }
        }
      }
    `;

    const minimalQuery = `
      query GetPrintModelMinimal($id: ID!) {
        print(id: $id) {
          id
          name
          slug
          summary
          description
          tags {
            name
          }
        }
      }
    `;

    let gqlPrint = null;
    try {
      const gqlRes = await queryPrintablesGraphQL(fullQuery, { id: modelId });
      if (gqlRes && gqlRes.data && gqlRes.data.print) {
        gqlPrint = gqlRes.data.print;
      } else {
        const minRes = await queryPrintablesGraphQL(minimalQuery, { id: modelId });
        if (minRes && minRes.data && minRes.data.print) {
          gqlPrint = minRes.data.print;
        }
      }
    } catch (gqlErr) {
      console.warn('Printables GraphQL warning:', gqlErr.message);
    }

    if (gqlPrint) {
      title = gqlPrint.name || '';
      summary = gqlPrint.summary || '';
      descriptionHtml = gqlPrint.description || '';

      if (Array.isArray(gqlPrint.tags)) {
        tags = gqlPrint.tags.map((t) => (t && t.name ? String(t.name).trim() : '')).filter(Boolean);
      }

      if (gqlPrint.category && Array.isArray(gqlPrint.category.path)) {
        categoryPath = gqlPrint.category.path.map((c) => c && c.name).filter(Boolean);
      }

      const rawPaths = [];
      // If Printables provides a dedicated cover image, ensure it is first in the list
      if (gqlPrint.image && gqlPrint.image.filePath) {
        rawPaths.push(gqlPrint.image.filePath);
      }
      if (Array.isArray(gqlPrint.images)) {
        // Sort images by Printables order field (order: 0, 1, 2...)
        const sortedImages = gqlPrint.images.slice().sort((a, b) => {
          const ordA = typeof a.order === 'number' ? a.order : 0;
          const ordB = typeof b.order === 'number' ? b.order : 0;
          return ordA - ordB;
        });
        sortedImages.forEach((img) => {
          if (img && img.filePath && !rawPaths.includes(img.filePath)) {
            rawPaths.push(img.filePath);
          }
        });
      }
      imageUrls = rawPaths.map((fp) => {
        const cleanFp = String(fp).replace(/^\/+/, '');
        return cleanFp.startsWith('http') ? cleanFp : `https://media.printables.com/${cleanFp}`;
      });
    }

    // 2. Fallback / Supplement: Fetch public Printables HTML page if title or description is still missing
    if (!title || !descriptionHtml) {
      try {
        const pageRes = await fetch(rawUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml'
          }
        });
        if (pageRes.ok) {
          const html = await pageRes.text();

          if (!title) {
            const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
            if (ogTitle) {
              title = decodeHtmlEntities(ogTitle[1]).replace(/\s+by\s+[^|]+(\|\s*Download free STL model)?\s*\|\s*Printables\.com$/i, '').trim();
            }
          }

          if (!summary) {
            const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
            if (ogDesc) {
              summary = decodeHtmlEntities(ogDesc[1]).trim();
            }
          }

          if (imageUrls.length === 0) {
            const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
            if (ogImg && ogImg[1]) {
              imageUrls.push(ogImg[1]);
            }
          }
        }
      } catch (htmlErr) {
        console.warn('Printables HTML fallback warning:', htmlErr.message);
      }
    }

    if (!title && !descriptionHtml && !summary) {
      return res.status(502).json({
        error: 'Could not retrieve model details from Printables. Check that the model URL is public and reachable.'
      });
    }

    const descriptionMarkdown = htmlToMarkdown(descriptionHtml);
    const decodedFullTitle = decodeHtmlEntities(title).trim();
    const { title: splitMainTitle, extendedTitle: splitExtendedTitle } =
      splitTitleOnFirstPipe(decodedFullTitle);
    const cleanTagline = decodeHtmlEntities(summary).trim();

    // Extract all YouTube links inside the description HTML/Markdown and classify Shorts vs long videos
    const { youtubeShorts, youtubeVideos, youtubeId } = await extractAndClassifyYoutubeVideos(
      `${descriptionHtml} ${descriptionMarkdown}`,
      false
    );

    // Extract photos embedded in the Printables description that are not already in the top photo section
    const allDescriptionImageUrls = extractDescriptionImages(descriptionHtml, imageUrls);

    // Animated GIFs can't be cropped to WebP stills; pull them out and return the first as the animation
    const isGifUrl = (u) => /\.gif$/i.test(String(u || '').split(/[?#]/)[0]);
    const animationUrl = [...imageUrls, ...allDescriptionImageUrls].find(isGifUrl) || '';
    imageUrls = imageUrls.filter((u) => !isGifUrl(u));
    const descriptionImageUrls = allDescriptionImageUrls.filter((u) => !isGifUrl(u));

    // Guess best matching catalog category if possible
    const combinedText = `${decodedFullTitle} ${tags.join(' ')} ${categoryPath.join(' ')}`.toLowerCase();
    let suggestedCategory = null;
    let suggestedFanFavorite = false;
    if (/(christmas|halloween|autumn|fall|pumpkin|easter|valentine|holiday|seasonal|ornament|winter|thanksgiving)/.test(combinedText)) {
      suggestedCategory = 'seasonal';
    } else if (/(organizer|holder|mount|stand|bracket|clip|adapter|tool|tray|sorter|box|hook|storage|functional)/.test(combinedText)) {
      suggestedCategory = 'useful-prints';
    } else if (/(fidget|articulated|flexi|toy|game|puzzle)/.test(combinedText)) {
      suggestedCategory = 'gifts-decor';
      suggestedFanFavorite = true;
    } else if (/(decor|vase|coaster|planter|gift|statue|art|sign|duck|figurine|cute)/.test(combinedText)) {
      suggestedCategory = 'gifts-decor';
    }

    if (/(favorite|popular|viral|bestseller)/.test(combinedText)) {
      suggestedFanFavorite = true;
    }

    return res.json({
      success: true,
      modelId,
      url: rawUrl,
      title: splitMainTitle,
      extendedTitle: splitExtendedTitle,
      tagline: cleanTagline,
      shortname: toShortname(splitMainTitle),
      description: descriptionMarkdown,
      summary: cleanTagline,
      tags,
      youtubeShorts,
      youtubeVideos,
      youtubeId,
      suggestedCategory,
      suggestedFanFavorite,
      imageUrls,
      animationUrl,
      descriptionImageUrls
    });
  } catch (err) {
    console.error('Printables import error:', err);
    return res.status(500).json({ error: `Failed to import from Printables: ${err.message}` });
  }
});

/**
 * Normalize a Printables image URL (strip #hash and ?query) and compute a deduplication key
 */
function getPrintablesImageDedupKeys(rawUrl) {
  const cleanUrl = String(rawUrl || '')
    .trim()
    .replace(/#.*$/, '')
    .replace(/\?.*$/, '');
  if (!cleanUrl) return { cleanUrl: '', pathKey: '' };

  let pathname = cleanUrl;
  try {
    pathname = new URL(cleanUrl).pathname;
  } catch (e) {
    // keep cleanUrl
  }
  const pathKey = pathname.toLowerCase().replace(/^\/+/, '');
  return { cleanUrl, pathKey };
}

/**
 * Extract all image URLs from Printables description HTML/Markdown that are not already in galleryImageUrls
 */
function extractDescriptionImages(descriptionHtml, galleryImageUrls = []) {
  if (!descriptionHtml || typeof descriptionHtml !== 'string') return [];

  const seenPaths = new Set();

  (Array.isArray(galleryImageUrls) ? galleryImageUrls : []).forEach((u) => {
    const { pathKey } = getPrintablesImageDedupKeys(u);
    if (pathKey) seenPaths.add(pathKey);
  });

  const candidateUrls = [];

  // 1. HTML <img> tags (src or data-src, single/double/unquoted)
  const imgTagRegex = /<img\b[^>]*>/gi;
  let tagMatch;
  while ((tagMatch = imgTagRegex.exec(descriptionHtml)) !== null) {
    const tag = tagMatch[0];
    const srcMatch =
      tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) ||
      tag.match(/\bdata-src\s*=\s*["']([^"']+)["']/i) ||
      tag.match(/\bsrc\s*=\s*([^\s"'<>]+)/i);
    if (srcMatch && srcMatch[1]) {
      candidateUrls.push(srcMatch[1]);
    }
  }

  // 2. Markdown image syntax ![alt](url)
  const mdImgRegex = /!\[[^\]]*\]\(\s*([^)\s"']+)(?:\s+["'][^"']*["'])?\s*\)/g;
  let mdMatch;
  while ((mdMatch = mdImgRegex.exec(descriptionHtml)) !== null) {
    if (mdMatch[1]) {
      candidateUrls.push(mdMatch[1]);
    }
  }

  // 3. Any direct media.printables.com image URLs in the description
  const directMediaRegex =
    /(https?:\/\/media\.printables\.com\/media\/prints\/[^\s"'<>()]+\.(?:png|jpe?g|webp|gif))/gi;
  let directMatch;
  while ((directMatch = directMediaRegex.exec(descriptionHtml)) !== null) {
    if (directMatch[1]) {
      candidateUrls.push(directMatch[1]);
    }
  }

  const out = [];
  for (const rawCandidate of candidateUrls) {
    let rawSrc = decodeHtmlEntities(rawCandidate || '').trim();
    if (!rawSrc) continue;
    rawSrc = rawSrc.replace(/#.*$/, '').trim();
    if (!rawSrc) continue;
    if (rawSrc.startsWith('//')) {
      rawSrc = `https:${rawSrc}`;
    } else if (rawSrc.startsWith('/')) {
      rawSrc = `https://media.printables.com${rawSrc}`;
    } else if (!rawSrc.startsWith('http')) {
      rawSrc = `https://media.printables.com/${rawSrc}`;
    }

    const { cleanUrl, pathKey } = getPrintablesImageDedupKeys(rawSrc);
    if (!cleanUrl || !pathKey) continue;
    if (seenPaths.has(pathKey)) continue;

    seenPaths.add(pathKey);
    out.push(cleanUrl);
  }

  return out;
}

/**
 * Determine whether a YouTube video ID is a YouTube Short (9:16 vertical short) vs a standard long-form video
 */
async function checkIsYoutubeShort(videoId, rawUrlHint = '') {
  if (!videoId) return false;
  if (/youtube\.com\/shorts\//i.test(String(rawUrlHint || ''))) {
    return true;
  }
  try {
    const headRes = await fetch(`https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`, {
      method: 'HEAD',
      redirect: 'manual',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });
    // YouTube returns 200 OK on /shorts/<id> for true Shorts, and 303 Redirect to /watch?v=<id> for regular videos
    if (headRes.status === 200) {
      return true;
    }
  } catch (e) {
    // ignore network error and fall back to false
  }
  return false;
}

/**
 * Extract all unique YouTube video IDs from text/HTML and classify into youtubeShorts and youtubeVideos.
 * Only allows bare 11-char IDs when allowBareIds === true (e.g. direct user input in /api/youtube/classify).
 */
async function extractAndClassifyYoutubeVideos(text, allowBareIds = false) {
  const raw = String(text || '');
  const regex = /(https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11}))/gi;
  const entries = [];
  const seen = new Set();

  let match;
  while ((match = regex.exec(raw)) !== null) {
    const fullUrl = match[1];
    const vid = match[2];
    if (vid && !seen.has(vid)) {
      seen.add(vid);
      entries.push({ id: vid, url: fullUrl });
    }
  }

  // Only support bare 11-char IDs when explicitly called from /api/youtube/classify
  if (allowBareIds && entries.length === 0) {
    raw
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .forEach((token) => {
        const id = cleanYoutubeId(token);
        if (id && /^[A-Za-z0-9_-]{11}$/.test(id) && !seen.has(id)) {
          seen.add(id);
          entries.push({ id, url: token });
        }
      });
  }

  const youtubeShorts = [];
  const youtubeVideos = [];

  for (const item of entries) {
    const isShort = await checkIsYoutubeShort(item.id, item.url);
    if (isShort) {
      youtubeShorts.push(item.id);
    } else {
      youtubeVideos.push(item.id);
    }
  }

  return {
    youtubeShorts,
    youtubeVideos,
    youtubeId: youtubeShorts[0] || youtubeVideos[0] || ''
  };
}

/**
 * POST /api/youtube/classify — Classify one or more YouTube URLs/IDs into Shorts vs Long Videos
 */
app.post('/api/youtube/classify', async (req, res) => {
  try {
    const input = String(req.body.input || '').trim();
    if (!input) {
      return res.json({ youtubeShorts: [], youtubeVideos: [] });
    }
    const result = await extractAndClassifyYoutubeVideos(input, true);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// CRC32 table for pure-Node zip packaging
let crc32LookupTable = null;
function getCrc32LookupTable() {
  if (crc32LookupTable) return crc32LookupTable;
  crc32LookupTable = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc32LookupTable[i] = c;
  }
  return crc32LookupTable;
}

function computeBufferCrc32(buf) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buf);
  }
  const table = getCrc32LookupTable();
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}

function getCurrentDosDateTime() {
  const d = new Date();
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = d.getSeconds();

  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (Math.floor(seconds / 2) & 0x1f);
  const dosDate = (((Math.max(1980, year) - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Pure Node.js ZIP archive creator (PKZIP 2.0 with DEFLATE / STORE)
 * Zero external CLI dependencies (works on all platforms: Linux, macOS, Windows without zip binary).
 * Includes explicit directory entries and Unix/DOS attributes for perfect compatibility across all extractors.
 * @param {Array<{ name: string, data?: Buffer, isDirectory?: boolean }>} entries
 * @returns {Buffer}
 */
function buildZipArchiveBuffer(entries) {
  const localHeaders = [];
  const centralDirHeaders = [];
  let offset = 0;
  const { dosTime, dosDate } = getCurrentDosDateTime();

  for (const entry of entries) {
    const rawName = String(entry.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const isDir = Boolean(entry.isDirectory || rawName.endsWith('/'));
    const normalizedName = isDir && !rawName.endsWith('/') ? rawName + '/' : rawName;
    const nameBuf = Buffer.from(normalizedName, 'utf8');

    const uncompressedData = isDir ? Buffer.alloc(0) : (entry.data || Buffer.alloc(0));
    const uncompressedSize = uncompressedData.length;
    const crc = isDir ? 0 : computeBufferCrc32(uncompressedData);

    let compressionMethod = 0; // STORE
    let dataToWrite = uncompressedData;
    if (!isDir && uncompressedSize > 0) {
      try {
        const compressedData = zlib.deflateRawSync(uncompressedData);
        if (compressedData.length < uncompressedSize) {
          compressionMethod = 8; // DEFLATE
          dataToWrite = compressedData;
        }
      } catch (e) {
        compressionMethod = 0;
        dataToWrite = uncompressedData;
      }
    }
    const compressedSize = dataToWrite.length;

    // External file attributes:
    // Directory: Unix 040755 << 16 | DOS directory bit 0x10 = 0x41ed0010
    // File: Unix 0100644 << 16 | DOS archive bit 0x20 = 0x81a40020
    const externalAttr = isDir ? 0x41ed0010 : 0x81a40020;

    // Local file header (30 bytes + name length)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
    localHeader.writeUInt16LE(20, 4);         // Version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6);     // Flag: Bit 11 set for UTF-8 filename
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);         // Extra field length
    nameBuf.copy(localHeader, 30);

    localHeaders.push(localHeader);
    if (dataToWrite.length > 0) {
      localHeaders.push(dataToWrite);
    }

    // Central directory header (46 bytes + name length)
    const cdHeader = Buffer.alloc(46 + nameBuf.length);
    cdHeader.writeUInt32LE(0x02014b50, 0);    // Central directory signature
    cdHeader.writeUInt16LE((3 << 8) | 20, 4); // Made by: Unix (3), Spec 2.0 (20)
    cdHeader.writeUInt16LE(20, 6);            // Needed: 2.0
    cdHeader.writeUInt16LE(0x0800, 8);        // Flag: UTF-8 filename
    cdHeader.writeUInt16LE(compressionMethod, 10);
    cdHeader.writeUInt16LE(dosTime, 12);
    cdHeader.writeUInt16LE(dosDate, 14);
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(compressedSize, 20);
    cdHeader.writeUInt32LE(uncompressedSize, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);            // Extra field length
    cdHeader.writeUInt16LE(0, 32);            // File comment length
    cdHeader.writeUInt16LE(0, 34);            // Disk number start
    cdHeader.writeUInt16LE(0, 36);            // Internal file attributes
    cdHeader.writeUInt32LE(externalAttr, 38);  // External file attributes
    cdHeader.writeUInt32LE(offset, 42);       // Relative offset of local header
    nameBuf.copy(cdHeader, 46);

    centralDirHeaders.push(cdHeader);
    offset += localHeader.length + dataToWrite.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of centralDirHeaders) cdSize += c.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, ...centralDirHeaders, eocd]);
}

/**
 * Helper: Convert an image to JPG format. Tries convert, then magick, or copies file as fallback.
 */
function convertImageFileToJpg(srcPath, destPath) {
  // Try 'magick' first (ImageMagick v7, and avoids Windows system C:\Windows\System32\convert.exe)
  try {
    execFileSync('magick', [srcPath, '-quality', '92', destPath], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch (err1) {
    try {
      execFileSync('convert', [srcPath, '-quality', '92', destPath], { stdio: ['ignore', 'ignore', 'ignore'] });
      return true;
    } catch (err2) {
      fs.copyFileSync(srcPath, destPath);
      return false;
    }
  }
}

/**
 * POST /api/models/export-zip — Export selected models' data and photos into a zip archive.
 * If includePhotos is true:
 * - Creates a separate folder for each model named with the model's title.
 * - Converts all photos for that model into JPG format.
 * - Names the cover photo as cover.jpg.
 * Also includes catalog-models-export.csv in the root of the zip.
 */
app.post('/api/models/export-zip', async (req, res) => {
  let tmpExportDir = null;
  try {
    const slugs = Array.isArray(req.body.slugs) ? req.body.slugs : [];
    const includePhotos = Boolean(req.body.includePhotos);
    const matrixDrafts = (req.body.matrixDrafts && typeof req.body.matrixDrafts === 'object') ? req.body.matrixDrafts : {};

    if (!slugs.length) {
      return res.status(400).json({ error: 'No models selected for export.' });
    }

    // Prepare temp working directory
    tmpExportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-models-export-'));

    function sanitizeDirName(title, fallback) {
      let name = String(title || fallback || 'model').trim();
      name = name.replace(/[/\\?%*:|"<>]/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();
      name = name.replace(/[. ]+$/, '');
      return name || fallback || 'model';
    }

    function formatCsvValue(val) {
      const str = val === undefined || val === null ? '' : String(val);
      if (/[",\r\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }

    // Build CSV rows
    const csvHeaders = ['title', 'extended title', 'tagline', 'description', 'tags'];
    const csvRows = [csvHeaders.map(formatCsvValue).join(',')];

    // Track folder names to avoid collisions
    const usedFolderNames = new Set();
    const zipFilesList = [];

    for (const slug of slugs) {
      const mdFilename = `${slug}.md`;
      const mdPath = path.join(MODELS_DIR, mdFilename);
      const model = fs.existsSync(mdPath) ? parseModelMarkdown(mdFilename) : { slug, title: slug, tags: [] };

      // Apply any draft edits if passed from client
      const draft = matrixDrafts[slug] || {};
      const title = draft.title !== undefined ? String(draft.title).trim() : String(model.title || slug).trim();
      const extendedTitle = draft.extended_title !== undefined ? String(draft.extended_title).trim() : String(model.extended_title || '').trim();
      const tagline = draft.tagline !== undefined ? String(draft.tagline).trim() : String(model.tagline || '').trim();
      const description = draft.description !== undefined ? String(draft.description).trim() : String(model.description || '').trim();

      let tagsStr = '';
      if (draft.tags !== undefined) {
        tagsStr = String(draft.tags).split(',').map((t) => t.trim()).filter(Boolean).join(', ');
      } else if (Array.isArray(model.tags)) {
        tagsStr = model.tags.map((t) => String(t).trim()).filter(Boolean).join(', ');
      } else {
        tagsStr = String(model.tags || '').trim();
      }

      csvRows.push([
        formatCsvValue(title),
        formatCsvValue(extendedTitle),
        formatCsvValue(tagline),
        formatCsvValue(description),
        formatCsvValue(tagsStr)
      ].join(','));

      if (includePhotos) {
        let folderName = sanitizeDirName(title, slug);
        let folderCandidate = folderName;
        let counter = 2;
        while (usedFolderNames.has(folderCandidate.toLowerCase())) {
          folderCandidate = `${folderName} (${counter})`;
          counter++;
        }
        usedFolderNames.add(folderCandidate.toLowerCase());

        const modelFolder = path.join(tmpExportDir, folderCandidate);
        fs.mkdirSync(modelFolder, { recursive: true });

        // Add explicit directory entry in zip
        zipFilesList.push({
          name: `${folderCandidate}/`,
          isDirectory: true
        });

        // Collect only the model's active photos: cover_image, gallery_images, detailed_images
        // (Do NOT export orphaned files previously deleted from the model)
        const activePhotoWebPaths = [];
        if (model.cover_image) {
          activePhotoWebPaths.push({ role: 'cover', webPath: model.cover_image });
        }
        if (Array.isArray(model.gallery_images)) {
          model.gallery_images.forEach((p) => {
            if (p && !activePhotoWebPaths.some((x) => x.webPath === p)) {
              activePhotoWebPaths.push({ role: 'gallery', webPath: p });
            }
          });
        }
        if (Array.isArray(model.detailed_images)) {
          model.detailed_images.forEach((p) => {
            if (p && !activePhotoWebPaths.some((x) => x.webPath === p)) {
              activePhotoWebPaths.push({ role: 'detailed', webPath: p });
            }
          });
        }

        // Export active photos
        let photoIndex = 1;
        for (const item of activePhotoWebPaths) {
          // Resolve file on disk
          let relPath = item.webPath.replace(/^\/+/, '');
          let srcPath = path.join(REPO_ROOT, relPath);
          if (!fs.existsSync(srcPath)) {
            // Try relative to sourceDir
            const base = path.basename(item.webPath);
            if (sourceDir && fs.existsSync(path.join(sourceDir, base))) {
              srcPath = path.join(sourceDir, base);
            } else {
              continue; // file not found on disk
            }
          }

          let outFileName;
          if (item.role === 'cover') {
            outFileName = 'cover.jpg';
          } else {
            const rawBase = path.parse(srcPath).name;
            // Clean up prefix if desired or use baseName
            outFileName = `${rawBase}.jpg`;
          }

          const destPath = path.join(modelFolder, outFileName);
          convertImageFileToJpg(srcPath, destPath);
          if (fs.existsSync(destPath)) {
            zipFilesList.push({
              name: `${folderCandidate}/${outFileName}`,
              data: fs.readFileSync(destPath)
            });
          }
          photoIndex++;
        }
      }
    }

    // Write CSV file with UTF-8 BOM
    const csvContent = '\uFEFF' + csvRows.join('\r\n');
    zipFilesList.push({
      name: 'catalog-models-export.csv',
      data: Buffer.from(csvContent, 'utf8')
    });

    // Build zip buffer using pure Node.js (no external zip binary needed)
    const zipBuffer = buildZipArchiveBuffer(zipFilesList);

    // Send zip buffer
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="catalog-models-export.zip"');
    res.setHeader('Content-Length', zipBuffer.length);
    res.send(zipBuffer);

    // Clean up temp directory
    try {
      if (tmpExportDir && fs.existsSync(tmpExportDir)) {
        fs.rmSync(tmpExportDir, { recursive: true, force: true });
      }
    } catch (cleanupErr) {
      console.error('Export cleanup error:', cleanupErr);
    }
  } catch (err) {
    if (tmpExportDir && fs.existsSync(tmpExportDir)) {
      try {
        fs.rmSync(tmpExportDir, { recursive: true, force: true });
      } catch (e) {}
    }
    console.error('Error generating export zip:', err);
    res.status(500).json({ error: err.message || 'Failed to generate export zip.' });
  }
});

/**
 * GET /api/proxy-image — Safely proxy remote media images so the browser Canvas can convert them to WebP
 */
app.get('/api/proxy-image', async (req, res) => {
  try {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) {
      return res.status(400).send('Missing url parameter');
    }
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return res.status(400).send('Only http/https image URLs are allowed');
    }
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') {
      return res.status(403).send('Localhost URLs are not allowed');
    }

    const imgRes = await fetch(rawUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });
    if (!imgRes.ok) {
      return res.status(imgRes.status).send('Failed to fetch remote image');
    }
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await imgRes.arrayBuffer();
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

app.listen(PORT, () => {
  console.log(`3D Model Catalog Admin Uploader running at http://localhost:${PORT}`);
});
