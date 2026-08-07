#!/usr/bin/env python3
"""
Generate all Tauri app icons from a source PNG.
Requires: pip3 install Pillow
"""

import os
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance


def make_rounded(img, radius_percent=20):
    """Add rounded corners to image."""
    size = img.size[0]
    radius = int(size * radius_percent / 100)
    
    # Create mask with rounded corners
    mask = Image.new("L", img.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([0, 0, size, size], radius=radius, fill=255)
    
    # Apply mask
    result = Image.new("RGBA", img.size, (0, 0, 0, 0))
    result.paste(img, mask=mask)
    return result


def make_circle(img):
    """Make image circular."""
    size = img.size[0]
    
    # Create circular mask
    mask = Image.new("L", img.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse([0, 0, size, size], fill=255)
    
    # Apply mask
    result = Image.new("RGBA", img.size, (0, 0, 0, 0))
    result.paste(img, mask=mask)
    return result


def resize_hd(img, size, sharpen=True):
    """
    High-quality resize with optional sharpening for small icons.
    Uses multi-step downscaling for better quality.
    """
    # If source is much larger, do multi-step resize for better quality
    if img.width > size * 4:
        # First resize to 2x target size
        intermediate = img.resize((size * 2, size * 2), Image.LANCZOS)
        # Then resize to final size
        result = intermediate.resize((size, size), Image.LANCZOS)
    else:
        result = img.resize((size, size), Image.LANCZOS)
    
    # Apply sharpening for small icons (under 128px)
    if sharpen and size <= 128:
        # Subtle sharpening - adjust based on size
        if size <= 32:
            # Stronger sharpening for very small icons
            result = result.filter(ImageFilter.UnsharpMask(radius=0.5, percent=80, threshold=2))
        elif size <= 64:
            result = result.filter(ImageFilter.UnsharpMask(radius=0.5, percent=60, threshold=2))
        else:
            result = result.filter(ImageFilter.UnsharpMask(radius=0.5, percent=40, threshold=2))
    
    return result

# Paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
SOURCE_ICON = os.path.join(PROJECT_ROOT, "server/public/assets/logo-rounded.png")
ICONS_DIR = os.path.join(PROJECT_ROOT, "src-tauri/icons")

# Icon sizes needed for Tauri
ICON_SIZES = {
    # Standard sizes
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    
    # Windows Store logos
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}

# iOS sizes
IOS_SIZES = {
    "AppIcon-20x20@1x.png": 20,
    "AppIcon-20x20@2x.png": 40,
    "AppIcon-20x20@2x-1.png": 40,
    "AppIcon-20x20@3x.png": 60,
    "AppIcon-29x29@1x.png": 29,
    "AppIcon-29x29@2x.png": 58,
    "AppIcon-29x29@2x-1.png": 58,
    "AppIcon-29x29@3x.png": 87,
    "AppIcon-40x40@1x.png": 40,
    "AppIcon-40x40@2x.png": 80,
    "AppIcon-40x40@2x-1.png": 80,
    "AppIcon-40x40@3x.png": 120,
    "AppIcon-60x60@2x.png": 120,
    "AppIcon-60x60@3x.png": 180,
    "AppIcon-76x76@1x.png": 76,
    "AppIcon-76x76@2x.png": 152,
    "AppIcon-83.5x83.5@2x.png": 167,
    "AppIcon-512@2x.png": 1024,
}

# Android sizes
ANDROID_SIZES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}


def create_ico(source_img, output_path):
    """Create Windows .ico file with multiple sizes - HD quality."""
    sizes = [16, 24, 32, 48, 64, 128, 256]
    
    # Create list of resized images
    icons = []
    for size in sizes:
        resized = resize_hd(source_img.copy(), size, sharpen=True)
        # Ensure RGBA mode
        if resized.mode != 'RGBA':
            resized = resized.convert('RGBA')
        icons.append(resized)
    
    # Save ICO with all sizes - use the largest as base
    # Pillow ICO: pass all images and specify sizes explicitly
    icons[-1].save(
        output_path, 
        format="ICO",
        append_images=icons[:-1],
        sizes=[(s, s) for s in sizes]
    )
    print(f"  Created: {output_path} (sizes: {sizes})")


def create_icns(source_img, output_path, padding_percent=12):
    """Create macOS .icns file with padding to match system icon sizes - HD quality."""
    # Create a temporary directory with iconset
    iconset_dir = output_path.replace(".icns", ".iconset")
    os.makedirs(iconset_dir, exist_ok=True)
    
    icns_files = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }
    
    for filename, size in icns_files.items():
        # Calculate icon size with padding
        padding = int(size * padding_percent / 100)
        icon_size = size - (padding * 2)
        
        # Use HD resize with sharpening for small icons
        resized = resize_hd(source_img.copy(), icon_size, sharpen=(size <= 128))
        
        # Create new image with padding (transparent background)
        padded = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        padded.paste(resized, (padding, padding))
        padded.save(os.path.join(iconset_dir, filename), "PNG", optimize=True)
    
    # Use iconutil to create icns (macOS only)
    result = os.system(f"iconutil -c icns {iconset_dir} -o {output_path}")
    
    # Cleanup iconset
    import shutil
    shutil.rmtree(iconset_dir)
    
    if result == 0:
        print(f"  Created: {output_path}")
    else:
        print(f"  WARNING: iconutil failed for {output_path}")


def main():
    print(f"Loading source icon: {SOURCE_ICON}")
    
    if not os.path.exists(SOURCE_ICON):
        print(f"ERROR: Source icon not found: {SOURCE_ICON}")
        return
    
    # Load source image
    source = Image.open(SOURCE_ICON).convert("RGBA")
    print(f"  Source size: {source.width}x{source.height}")
    
    # Create icons directory if needed
    os.makedirs(ICONS_DIR, exist_ok=True)
    
    print("\nGenerating standard icons (HD quality)...")
    for filename, size in ICON_SIZES.items():
        output_path = os.path.join(ICONS_DIR, filename)
        resized = resize_hd(source.copy(), size, sharpen=True)
        resized.save(output_path, "PNG", optimize=True)
        print(f"  Created: {filename} ({size}x{size})")
    
    print("\nGenerating iOS icons (HD quality)...")
    ios_dir = os.path.join(ICONS_DIR, "ios")
    os.makedirs(ios_dir, exist_ok=True)
    for filename, size in IOS_SIZES.items():
        output_path = os.path.join(ios_dir, filename)
        resized = resize_hd(source.copy(), size, sharpen=True)
        resized.save(output_path, "PNG", optimize=True)
        print(f"  Created: ios/{filename} ({size}x{size})")
    
    print("\nGenerating Android icons (HD quality)...")
    android_dir = os.path.join(ICONS_DIR, "android")
    for folder, size in ANDROID_SIZES.items():
        folder_path = os.path.join(android_dir, folder)
        os.makedirs(folder_path, exist_ok=True)
        
        # Regular icon with HD resize
        resized = resize_hd(source.copy(), size, sharpen=True)
        resized.save(os.path.join(folder_path, "ic_launcher.png"), "PNG", optimize=True)
        
        # Round icon (same for now)
        resized.save(os.path.join(folder_path, "ic_launcher_round.png"), "PNG", optimize=True)
        
        # Foreground (larger, for adaptive icons)
        fg_size = int(size * 1.5)
        foreground = resize_hd(source.copy(), fg_size, sharpen=False)
        # Center on transparent background
        fg_img = Image.new("RGBA", (fg_size, fg_size), (0, 0, 0, 0))
        fg_img.paste(foreground, (0, 0))
        fg_img.save(os.path.join(folder_path, "ic_launcher_foreground.png"), "PNG", optimize=True)
        
        print(f"  Created: android/{folder}/ ({size}x{size})")
    
    print("\nGenerating Windows .ico...")
    create_ico(source, os.path.join(ICONS_DIR, "icon.ico"))
    
    print("\nGenerating macOS .icns...")
    create_icns(source, os.path.join(ICONS_DIR, "icon.icns"))
    
    print("\nGenerating tray icons (HD quality)...")
    # Tray icon - small with HD resize and sharpening
    tray_size = 22
    tray_icon = resize_hd(source.copy(), tray_size, sharpen=True)
    tray_icon.save(os.path.join(ICONS_DIR, "tray-icon.png"), "PNG", optimize=True)
    print(f"  Created: tray-icon.png ({tray_size}x{tray_size})")
    
    # Also create @2x version for retina
    tray_2x = resize_hd(source.copy(), 44, sharpen=True)
    tray_2x.save(os.path.join(ICONS_DIR, "tray-icon@2x.png"), "PNG", optimize=True)
    print(f"  Created: tray-icon@2x.png (44x44)")
    
    print("\nGenerating NSIS installer images (HD quality)...")
    # Header image for NSIS (150x57) - logo on right side with dark background
    header_width, header_height = 150, 57
    header = Image.new("RGB", (header_width, header_height), (30, 30, 30))  # Dark gray
    logo_size = 45
    logo = resize_hd(source.copy(), logo_size, sharpen=True)
    # Place logo on right side with padding
    header.paste(logo, (header_width - logo_size - 6, (header_height - logo_size) // 2), logo if logo.mode == 'RGBA' else None)
    header.save(os.path.join(ICONS_DIR, "nsis-header.bmp"), "BMP")
    print(f"  Created: nsis-header.bmp ({header_width}x{header_height})")
    
    # Sidebar image for NSIS (164x314) - logo centered with gradient
    sidebar_width, sidebar_height = 164, 314
    sidebar = Image.new("RGB", (sidebar_width, sidebar_height), (20, 20, 20))
    # Add gradient effect
    for y in range(sidebar_height):
        brightness = int(20 + (y / sidebar_height) * 15)
        for x in range(sidebar_width):
            sidebar.putpixel((x, y), (brightness, brightness, brightness + 5))
    # Place logo in upper portion with HD resize
    logo_sidebar_size = 100
    logo_sidebar = resize_hd(source.copy(), logo_sidebar_size, sharpen=True)
    x_pos = (sidebar_width - logo_sidebar_size) // 2
    y_pos = 60
    sidebar.paste(logo_sidebar, (x_pos, y_pos), logo_sidebar if logo_sidebar.mode == 'RGBA' else None)
    sidebar.save(os.path.join(ICONS_DIR, "nsis-sidebar.bmp"), "BMP")
    print(f"  Created: nsis-sidebar.bmp ({sidebar_width}x{sidebar_height})")
    
    print("\n✅ All icons generated successfully!")
    print(f"   Output directory: {ICONS_DIR}")


if __name__ == "__main__":
    main()
