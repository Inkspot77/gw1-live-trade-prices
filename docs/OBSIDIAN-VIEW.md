# 📚 Obsidian View Guide

This document explains how to use this repository as an Obsidian vault for project documentation and knowledge management.

## 🏗️ Project Structure

```
EctoWatch Project/
├── .obsidian/              # Obsidian configuration files
│   ├── appearance.json     # Theme and appearance settings
│   ├── app.json            # App preferences and layout
│   ├── core-plugins.json   # Core plugin settings
│   ├── graph.json          # Graph view configuration
│   └── workspace.json      # Workspace layout
├── docs/                   # Documentation files
│   └── OBSIDIAN-VIEW.md    # This file
├── deploy/                 # Deployment documentation
│   └── DEPLOY.md
├── CONTRIBUTING.md         # Contribution guidelines
├── CHANGELOG.md            # Version history
├── README.md               # Main project README
└── src/                    # Source code (hidden from vault view)
```

## 🎨 Obsidian Configuration

### Appearance Settings
- **Theme**: Moonlight (dark mode)
- **Base Font Size**: 16px
- **Font**: Serif for readability

### Workspace Layout
The workspace is configured with:
- **Left Panel**: File explorer, search, and bookmarks
- **Main Area**: Document editing/viewing
- **Right Panel**: Backlinks and outline navigation

### Graph View
The graph view is configured to:
- Show folder and tag groupings
- Hide empty files and orphaned notes
- Display internal links only (hides external references)

## 📝 Documentation Structure

### Main Documentation
- **README.md** - Project overview and quick start guide
- **CONTRIBUTING.md** - How to contribute to the project
- **CHANGELOG.md** - Version history and release notes
- **DEPLOY.md** - Deployment instructions for production

### Obsidian-Specific Files
- **OBSIDIAN-VIEW.md** - This guide for Obsidian usage
- **docs/** - Additional documentation files

## 🔍 Using Obsidian Features

### Graph View
Press `Ctrl/Cmd + G` or click the graph icon to see connections between documentation files.

### Search
Press `Ctrl/Cmd + Shift + F` for global search across all files.

### Backlinks
Click on linked terms to see where they are referenced, or use the backlinks panel.

### File Explorer
The left sidebar shows all files organized by folder. Use the search filter to quickly find files.

## 🎯 Best Practices

1. **Keep Documentation in Markdown**: All documentation should be in `.md` files
2. **Use Clear Headings**: Structure documents with proper headings for the outline view
3. **Link Related Topics**: Use Obsidian's link syntax `[[link text]]` to connect concepts
4. **Tag Your Notes**: Use tags like `#project`, `#documentation`, `#deployment` for organization
5. **Update README First**: When adding new features, update the README first

## 🔧 Customization

### Changing the Theme
Edit `.obsidian/appearance.json` and change the `theme` value:
- `"theme": "moonlight"` - Dark mode
- `"theme": "obsidian"` - Light mode

### Adjusting Font Size
Edit `.obsidian/appearance.json` and change `baseFontSize`:
- `"baseFontSize": 14` - Smaller
- `"baseFontSize": 18` - Larger

### Modifying Layout
Edit `.obsidian/workspace.json` to customize the workspace layout and panel sizes.

## 📦 GitHub Integration

This repository is designed to work seamlessly with GitHub:
- **README.md** is the main entry point
- **docs/** folder contains additional documentation
- **.obsidian/** folder IS committed, on purpose, so that cloning the repo
  and opening it in Obsidian gives everyone the same theme, plugins and
  graph settings — GitHub just renders it as an ordinary folder of JSON.
  Only `workspace.json` (per-session UI state — which tabs happened to be
  open) is excluded, since it has no shared meaning and would churn on
  every commit.
- All documentation files are Markdown format for easy GitHub rendering

To view the Obsidian vault on GitHub:
1. Navigate to the repository
2. Browse the `docs/` folder for documentation
3. View the main README.md file
4. Use the file explorer to navigate between documentation files

## 🚀 Getting Started

1. Open the folder in Obsidian
2. Review the workspace layout
3. Explore the documentation files
4. Use the graph view to see connections
5. Add your own notes and documentation

---

**Note**: The source code (`src/`, `bin/`, `public/`) is hidden from the Obsidian view to keep the focus on documentation. You can still access these files through your file system or GitHub.
