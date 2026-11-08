const express = require('express');
const fs = require('fs');
const path = require('path');
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
    shortname: slug,
    category: 'useful-prints',
    thumbnail_image: '',
    cover_image: '',
    gallery_images: [],
    animation: '',
    tags: [],
    downloads: {
      makerworld: '',
      printables: '',
      thangs: '',
      cults3d: ''
    },
    youtube_id: '',
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

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // List item under gallery_images or tags
    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && (currentKey === 'gallery_images' || currentKey === 'tags')) {
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

      if (key === 'gallery_images' || key === 'tags') {
        if (rawVal === '[]') {
          result[key] = [];
        }
      } else if (key === 'downloads') {
        // subsequent indented lines populate downloads
      } else if (key in result) {
        result[key] = yamlUnquote(rawVal);
      }
    }
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
 * Shared handler for creating or updating a model
 */
function saveAndDeployModel(req, res) {
  try {
    const {
      originalSlug = null,
      title,
      shortname: rawShortname,
      category = 'useful-prints',
      description = '',
      printSettings = '',
      tags = '',
      youtubeId = '',
      downloads = {},
      mainImage = null,
      thumbImage = null,
      galleryImages = null,
      existingCoverImage = '',
      existingThumbImage = '',
      existingGalleryImages = [],
      existingAnimation = '',
      autoDeploy = true
    } = req.body;

    const isEdit = Boolean(originalSlug);

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'Model Name (title) is required.' });
    }

    const shortname = toShortname(rawShortname || title);
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

    // 5. Parse comma-separated tags
    const parsedTags = Array.isArray(tags)
      ? tags.map((t) => String(t).trim()).filter(Boolean)
      : String(tags || '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);

    const parsedYoutubeId = cleanYoutubeId(youtubeId);

    // 6. Build Jekyll Markdown with YAML Front Matter
    const yamlLines = [
      '---',
      `title: ${yamlQuote(title)}`,
      `shortname: ${yamlQuote(shortname)}`,
      `category: ${yamlQuote(category || 'useful-prints')}`,
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
    yamlLines.push(`youtube_id: ${yamlQuote(parsedYoutubeId)}`);
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
        const commitMessage = `${actionVerb} ${String(title).trim()}`;
        const commitOut = execFileSync('git', ['commit', '-m', commitMessage], {
          cwd: REPO_ROOT,
          encoding: 'utf8'
        });
        gitLog.push(`$ git commit -m "${commitMessage}"\n${commitOut.trim()}`);

        const pushOut = execFileSync('git', ['push'], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        });
        gitLog.push(`$ git push\n${(pushOut || 'Pushed to remote origin.').trim()}`);
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
      title: String(title).trim(),
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

app.listen(PORT, () => {
  console.log(`3D Model Catalog Admin Uploader running at http://localhost:${PORT}`);
});
