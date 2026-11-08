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
 * GET /api/models — List existing models in _models/
 */
app.get('/api/models', (req, res) => {
  try {
    if (!fs.existsSync(MODELS_DIR)) {
      return res.json({ models: [] });
    }
    const files = fs
      .readdirSync(MODELS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((filename) => {
        const content = fs.readFileSync(path.join(MODELS_DIR, filename), 'utf8');
        const titleMatch = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
        const catMatch = content.match(/^category:\s*["']?(.+?)["']?\s*$/m);
        return {
          filename,
          slug: filename.replace(/\.md$/, ''),
          title: titleMatch ? titleMatch[1] : filename,
          category: catMatch ? catMatch[1] : 'useful-prints'
        };
      });
    res.json({ models: files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/models — Save WebP images, generate Jekyll Markdown, and auto-deploy via Git
 */
app.post('/api/models', (req, res) => {
  try {
    const {
      title,
      shortname: rawShortname,
      category = 'useful-prints',
      description = '',
      printSettings = '',
      tags = '',
      youtubeId = '',
      downloads = {},
      mainImage,
      thumbImage,
      galleryImages = [],
      autoDeploy = true
    } = req.body;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'Model Name (title) is required.' });
    }

    const shortname = toShortname(rawShortname || title);
    if (!shortname) {
      return res.status(400).json({ error: 'Could not derive a valid shortname slug.' });
    }

    if (!mainImage || !thumbImage) {
      return res.status(400).json({
        error: 'At least one image must be pasted to generate the 1200x1200 main and 600x600 thumbnail WebP files.'
      });
    }

    // 1. Create /images/models/[model-shortname]/ directory
    const modelImageDir = path.join(IMAGES_MODELS_DIR, shortname);
    fs.mkdirSync(modelImageDir, { recursive: true });
    fs.mkdirSync(MODELS_DIR, { recursive: true });

    const savedFiles = [];

    // 2. Save Main Showcase Image (1200x1200px): 3d-model-[shortname]-main.webp
    const mainFilename = `3d-model-${shortname}-main.webp`;
    const mainDiskPath = path.join(modelImageDir, mainFilename);
    const mainWebPath = `/images/models/${shortname}/${mainFilename}`;
    fs.writeFileSync(mainDiskPath, decodeBase64WebP(mainImage));
    savedFiles.push(mainWebPath);

    // 3. Save Model Thumbnail (600x600px): 3d-model-[shortname]-thumb.webp
    const thumbFilename = `3d-model-${shortname}-thumb.webp`;
    const thumbDiskPath = path.join(modelImageDir, thumbFilename);
    const thumbWebPath = `/images/models/${shortname}/${thumbFilename}`;
    fs.writeFileSync(thumbDiskPath, decodeBase64WebP(thumbImage));
    savedFiles.push(thumbWebPath);

    // 4. Save Additional Gallery Images (1000x1000px): 3d-model-[shortname]-angle1.webp, angle2.webp, ...
    const galleryWebPaths = [];
    if (Array.isArray(galleryImages)) {
      galleryImages.forEach((dataUrl, idx) => {
        if (!dataUrl) return;
        const angleFilename = `3d-model-${shortname}-angle${idx + 1}.webp`;
        const angleDiskPath = path.join(modelImageDir, angleFilename);
        const angleWebPath = `/images/models/${shortname}/${angleFilename}`;
        fs.writeFileSync(angleDiskPath, decodeBase64WebP(dataUrl));
        galleryWebPaths.push(angleWebPath);
        savedFiles.push(angleWebPath);
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
    const mdFilename = `${shortname}.md`;
    const mdDiskPath = path.join(MODELS_DIR, mdFilename);
    const mdWebPath = `/_models/${mdFilename}`;

    fs.writeFileSync(mdDiskPath, markdownContent, 'utf8');
    savedFiles.push(mdWebPath);

    // 7. Auto-Deploy: git add ., git commit -m "Add [model name]", git push
    const gitLog = [];
    let deployed = false;
    let gitError = null;

    if (autoDeploy !== false) {
      try {
        execFileSync('git', ['add', '.'], { cwd: REPO_ROOT, encoding: 'utf8' });
        gitLog.push('$ git add .');

        const commitMessage = `Add ${String(title).trim()}`;
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
      shortname,
      markdownPath: mdWebPath,
      markdownContent,
      savedFiles,
      deployed,
      gitError,
      gitLog: gitLog.join('\n\n')
    });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`3D Model Catalog Admin Uploader running at http://localhost:${PORT}`);
});
