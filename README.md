# 3D Model Catalog — Karen Chau Designs

A Jekyll portfolio and digital catalog optimized for GitHub Pages to showcase 3D printing models, categorized galleries, and multi-platform download links (MakerWorld, Printables, Thangs, and Cults3D).

## Folder Structure

```text
3d-model-catalog/
├── _config.yml                              # Jekyll & _models collection configuration
├── _layouts/
│   ├── default.html                         # Base site shell, header navigation & footer
│   ├── category.html                        # Category gallery layout (4–5 cols desktop, 2–3 mobile)
│   └── model.html                           # Model detail layout with conditional downloads & embeds
├── _models/
│   └── hex-modular-desk-organizer.md        # Sample 3D model entry with full YAML front matter
├── categories/
│   ├── useful-prints.md                     # Sample category landing page (Useful Prints)
│   ├── gifts-decor.md                       # Category landing page (Gifts & Decor)
│   ├── seasonal.md                          # Category landing page (Seasonal)
│   └── fan-favorites.md                     # Category landing page (Fan Favorites)
├── assets/
│   └── css/
│       └── style.css                        # Minimalist, image-first responsive stylesheet
├── images/
│   ├── categories/
│   │   ├── category-useful-prints-3dmodels.webp   # 800x800px
│   │   ├── category-gifts-decor-3dmodels.webp     # 800x800px
│   │   ├── category-seasonal-3dmodels.webp        # 800x800px
│   │   └── category-fan-favorites-3dmodels.webp   # 800x800px
│   └── models/
│       ├── 3d-model-hex-organizer-thumb.webp      # 600x600px
│       ├── 3d-model-hex-organizer-main.webp       # 1200x1200px
│       ├── 3d-model-hex-organizer-angle1.webp     # 1000x1000px
│       ├── 3d-model-hex-organizer-angle2.webp     # 1000x1000px
│       └── 3d-model-hex-organizer-loop.mp4        # Looping showcase animation
├── index.html                               # Root catalog page (Category grid + tag filter gallery)
└── Gemfile                                  # GitHub Pages gem dependencies
```

## Image Optimization & Naming Conventions

All model and category assets follow strict SEO naming and sizing conventions:

| Asset Type | Naming Convention | Dimensions |
| :--- | :--- | :--- |
| **Category Thumbnails** | `/images/categories/category-[name]-3dmodels.webp` | `800x800px` |
| **Model Thumbnails** | `/images/models/3d-model-[shortname]-thumb.webp` | `600x600px` |
| **Main Showcase Image** | `/images/models/3d-model-[shortname]-main.webp` | `1200x1200px` |
| **Additional Gallery Images** | `/images/models/3d-model-[shortname]-angle1.webp` | `1000x1000px` |
| **Looping Animations** | `/images/models/3d-model-[shortname]-loop.mp4` | `600x600px` MP4 |