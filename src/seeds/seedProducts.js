// src/seeds/seedProducts.js
// Seeds 6 single-type products in each of the 7 main categories (42 total).
// 7 of them are marked as featured to appear on the home page featured section.
const mongoose = require('mongoose');
const Product = require('../models/product');
const Category = require('../models/category');
require('dotenv').config();

const slugify = (str) =>
  String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

// 6 products per main category.
const products = [
  // ====== Lighting (6) ======
  {
    name: 'Premium LED Headlight Bulbs H4 - 12000LM',
    category: 'Lighting',
    subCategory: 'Headlight Bulbs',
    price: 4500,
    discountedPrice: 3999,
    stock: 50,
    thumbnailUrl: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Ultra-bright H4 LED headlight bulbs with 12,000 lumens output.',
    features: '6500K white light, 50,000-hour lifespan, built-in cooling fan, universal H4 socket.',
    tags: ['led', 'headlight', 'h4'],
    featured: true,
  },
  {
    name: 'Waterproof RGB LED Strip Kit - 5M',
    category: 'Lighting',
    subCategory: 'LED Strips',
    price: 1800,
    discountedPrice: 1499,
    stock: 120,
    thumbnailUrl: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?auto=format&fit=crop&w=800&q=80',
    shortDescription: '5-meter RGB LED strip with remote control for interior ambient lighting.',
    features: 'Multi-color RGB, remote control, adhesive backing, 12V, waterproof IP65.',
    tags: ['led', 'rgb', 'strip'],
  },
  {
    name: 'Sequential LED Tail Light Assembly - Pair',
    category: 'Lighting',
    subCategory: 'Tail Lights',
    price: 8500,
    discountedPrice: 7499,
    stock: 30,
    thumbnailUrl: 'https://images.unsplash.com/photo-1544636331-e26879cd4d9b?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Smoked sequential LED tail lights with dynamic turn signal indicators.',
    features: 'Sequential turn signals, smoked lens, plug-and-play, DOT compliant, LED brake lights.',
    tags: ['tail-light', 'led', 'sequential'],
  },
  {
    name: 'Bi-LED Projector Headlight Retrofit Kit',
    category: 'Lighting',
    subCategory: 'Projector Headlights',
    price: 12000,
    discountedPrice: 10499,
    stock: 15,
    thumbnailUrl: 'https://images.unsplash.com/photo-1489824904134-891ab64532f1?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Complete Bi-LED projector retrofit kit with angel eye shrouds.',
    features: '3-inch projector, 55W Bi-LED, angel eye halo ring, H4/H7 adapter, 6000K output.',
    tags: ['projector', 'bi-led', 'retrofit'],
  },
  {
    name: 'Ultra Slim DRL LED Daytime Running Lights',
    category: 'Lighting',
    subCategory: 'DRL Lights',
    price: 2200,
    discountedPrice: 1899,
    stock: 80,
    thumbnailUrl: 'https://images.unsplash.com/photo-1494976388531-d1058494ceb8?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Slim profile DRL lights with switchback amber turn signal function.',
    features: 'White DRL + amber turn signal, flexible mounting, waterproof IP67, 12V DC.',
    tags: ['drl', 'daytime-running-lights', 'switchback'],
  },
  {
    name: 'Yellow Fog Lamp LED Bulbs H11 - Pair',
    category: 'Lighting',
    subCategory: 'Fog Lamps',
    price: 2800,
    discountedPrice: 2399,
    stock: 60,
    thumbnailUrl: 'https://images.unsplash.com/photo-1511919884226-fd3cad34687c?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Golden yellow H11 LED fog lamp bulbs for improved visibility in bad weather.',
    features: '3000K golden yellow, 4000 lumens, CAN-bus ready, all-weather, H11/H8/H16 fitment.',
    tags: ['fog-lamp', 'yellow', 'h11'],
  },

  // ====== Exterior (6) ======
  {
    name: 'Carbon Fiber Rear Spoiler - Universal',
    category: 'Exterior',
    subCategory: 'Spoilers',
    price: 6500,
    discountedPrice: 5799,
    stock: 25,
    thumbnailUrl: 'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Sleek carbon fiber rear spoiler for a sporty, aggressive look.',
    features: 'Real carbon fiber weave, 3M adhesive mounting, universal fit for sedans.',
    tags: ['carbon-fiber', 'spoiler'],
    featured: true,
  },
  {
    name: 'Chrome Door Handle Cover Set (4 Pcs)',
    category: 'Exterior',
    subCategory: 'Door Handles',
    price: 2200,
    stock: 80,
    thumbnailUrl: 'https://images.unsplash.com/photo-1550355291-bbee04a92027?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Universal chrome door handle covers for a premium exterior look.',
    features: 'High-grade ABS chrome plating, peel-and-stick installation, scratch resistant.',
    tags: ['chrome', 'door-handle'],
  },
  {
    name: 'Window Visor Rain Guards - Set of 4',
    category: 'Exterior',
    subCategory: 'Window Visors',
    price: 1800,
    discountedPrice: 1499,
    stock: 100,
    thumbnailUrl: 'https://images.unsplash.com/photo-1542362567-b07e54358753?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Slim-profile window visors allowing fresh air in rain without wind noise.',
    features: 'Acrylic material, 3M adhesive tape, set of 4, reduces cabin heat, UV resistant.',
    tags: ['window-visor', 'rain-guard'],
  },
  {
    name: 'Matte Black Vinyl Car Wrap - 5ft x 10ft',
    category: 'Exterior',
    subCategory: 'Car Wraps',
    price: 8500,
    discountedPrice: 7299,
    stock: 40,
    thumbnailUrl: 'https://images.unsplash.com/photo-1603584173870-7f23fdae1b7a?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Premium matte black vinyl wrap with air-release channels for bubble-free application.',
    features: 'Air-release technology, repositionable, 3-year outdoor durability, 60" x 120" roll.',
    tags: ['vinyl-wrap', 'matte-black'],
  },
  {
    name: 'Universal Mud Flaps - Heavy Duty Set',
    category: 'Exterior',
    subCategory: 'Mud Flaps',
    price: 1200,
    stock: 150,
    thumbnailUrl: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Durable heavy-duty mud flaps to protect your car body from road debris.',
    features: 'Flexible rubber, universal fit, front and rear set, easy bolt-on install.',
    tags: ['mud-flaps', 'splash-guard'],
  },
  {
    name: 'Hybrid Silicone Wiper Blades - Pair',
    category: 'Exterior',
    subCategory: 'Wiper Blades',
    price: 1600,
    discountedPrice: 1299,
    stock: 200,
    thumbnailUrl: 'https://images.unsplash.com/photo-1549317661-bd32c8ce0220?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Premium hybrid silicone wiper blades for streak-free, silent wiping.',
    features: 'Silicone rubber, hybrid frame design, fits 90% of cars, 12-month warranty.',
    tags: ['wiper-blade', 'silicone'],
  },

  // ====== Interior (6) ======
  {
    name: 'Genuine Leather Steering Wheel Cover - Black',
    category: 'Interior',
    subCategory: 'Steering Wheel Covers',
    price: 1500,
    stock: 150,
    thumbnailUrl: 'https://images.unsplash.com/photo-1449965408869-eaa3f722e40d?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Premium genuine leather steering wheel cover with non-slip grip.',
    features: 'Hand-stitched genuine leather, anti-slip design, fits 37-39cm steering wheels.',
    tags: ['leather', 'steering-wheel'],
    featured: true,
  },
  {
    name: 'Premium 7D Car Floor Mats - Universal',
    category: 'Interior',
    subCategory: 'Car Floor Mats',
    price: 9500,
    discountedPrice: 8499,
    stock: 30,
    thumbnailUrl: 'https://images.unsplash.com/photo-1537984822441-cff330075342?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Luxury 7D floor mats with anti-slip backing and waterproof design.',
    features: '7D design, PU leather, waterproof, anti-slip, full set for 5-seater.',
    tags: ['7d-mats', 'floor-mat'],
  },
  {
    name: 'PU Leather Seat Covers - Full Set',
    category: 'Interior',
    subCategory: 'Seat Covers',
    price: 14000,
    discountedPrice: 11999,
    stock: 20,
    thumbnailUrl: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Premium PU leather seat covers with lumbar support cushioning for all 5 seats.',
    features: 'PU leather, universal fit, airbag compatible, easy install, front + rear set.',
    tags: ['seat-cover', 'leather'],
  },
  {
    name: 'Crystal Gear Shift Knob - Universal',
    category: 'Interior',
    subCategory: 'Gear Knobs',
    price: 2500,
    discountedPrice: 2199,
    stock: 45,
    thumbnailUrl: 'https://images.unsplash.com/photo-1489824904134-891ab64532f1?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Diamond-cut crystal gear shift knob for a luxurious cabin upgrade.',
    features: 'Crystal glass material, universal thread adapters (8/10/12mm), LED illuminated base option.',
    tags: ['gear-knob', 'crystal'],
  },
  {
    name: 'Retractable Car Sun Shade - Windshield',
    category: 'Interior',
    subCategory: 'Sun Shades',
    price: 1800,
    discountedPrice: 1499,
    stock: 90,
    thumbnailUrl: 'https://images.unsplash.com/photo-1542362567-b07e54358753?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Retractable windshield sun shade that blocks 99% of UV rays.',
    features: 'Retractable roller design, suction cup mount, UV blocking, fits most windshields.',
    tags: ['sun-shade', 'uv-protection'],
  },
  {
    name: 'Luxury Car Perfume - Ocean Breeze',
    category: 'Interior',
    subCategory: 'Perfumes & Fragrances',
    price: 850,
    stock: 200,
    thumbnailUrl: 'https://images.unsplash.com/photo-1544636331-e26879cd4d9b?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Long-lasting ocean breeze car perfume with elegant dashboard-mount diffuser.',
    features: 'Lasts 60+ days, refillable, metal alloy body, non-spill design, subtle fragrance.',
    tags: ['perfume', 'air-freshener', 'fragrance'],
  },

  // ====== Car Care (6) ======
  {
    name: '9H Ceramic Coating - 50ml Pro Kit',
    category: 'Car Care',
    subCategory: 'Ceramic Coating',
    price: 12000,
    discountedPrice: 9999,
    stock: 20,
    thumbnailUrl: 'https://images.unsplash.com/photo-1605515298946-d0573716f0c1?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Professional-grade 9H ceramic coating for long-lasting paint protection.',
    features: '9H hardness, 3-year protection, hydrophobic effect, 50ml covers 1 car.',
    tags: ['ceramic-coating', '9h', 'protection'],
    featured: true,
  },
  {
    name: 'Microfiber Detailing Towels - Pack of 12',
    category: 'Car Care',
    subCategory: 'Microfiber Towels',
    price: 1800,
    stock: 200,
    thumbnailUrl: 'https://images.unsplash.com/photo-1486006920555-c77dcf18193c?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Ultra-absorbent microfiber towels for polishing and detailing.',
    features: '400 GSM, lint-free, 40x40cm, machine washable, pack of 12.',
    tags: ['microfiber', 'towel'],
  },
  {
    name: 'pH Neutral Snow Foam Car Shampoo - 1L',
    category: 'Car Care',
    subCategory: 'Car Shampoo',
    price: 1200,
    discountedPrice: 999,
    stock: 150,
    thumbnailUrl: 'https://images.unsplash.com/photo-1607860108855-64acf2078ed9?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Thick snow foam shampoo that gently lifts dirt without stripping wax or coatings.',
    features: 'pH neutral formula, 1:10 dilution ratio, safe on ceramic coatings, cherry scent, 1 liter.',
    tags: ['shampoo', 'snow-foam', 'car-wash'],
  },
  {
    name: 'Carnauba Wax Polish - 200g Tin',
    category: 'Car Care',
    subCategory: 'Wax & Polish',
    price: 3500,
    discountedPrice: 2999,
    stock: 60,
    thumbnailUrl: 'https://images.unsplash.com/photo-1605515298946-d0573716f0c1?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Premium Brazilian carnauba wax for a deep, wet-look shine and paint protection.',
    features: 'Grade-1 carnauba, 6-month protection, easy on/off, UV shield, 200g tin.',
    tags: ['wax', 'polish', 'carnauba'],
  },
  {
    name: 'Streak-Free Glass Cleaner Spray - 500ml',
    category: 'Car Care',
    subCategory: 'Glass Cleaner',
    price: 650,
    stock: 250,
    thumbnailUrl: 'https://images.unsplash.com/photo-1486006920555-c77dcf18193c?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Ammonia-free glass cleaner that leaves a crystal-clear, streak-free finish.',
    features: 'Ammonia-free, anti-static formula, safe on tinted glass, 500ml spray bottle.',
    tags: ['glass-cleaner', 'streak-free'],
  },
  {
    name: 'High-Gloss Tire Shine Gel - 250ml',
    category: 'Car Care',
    subCategory: 'Tire Shine',
    price: 900,
    discountedPrice: 749,
    stock: 180,
    thumbnailUrl: 'https://images.unsplash.com/photo-1607860108855-64acf2078ed9?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Long-lasting gel-based tire shine for a deep black, wet-look finish.',
    features: 'Silicone gel formula, lasts 2+ weeks, UV protectant, non-sling, 250ml.',
    tags: ['tire-shine', 'gel'],
  },

  // ====== Wheels & Performance (6) ======
  {
    name: '17 Inch Sport Alloy Rims - Set of 4',
    category: 'Wheels & Performance',
    subCategory: 'Alloy Rims',
    price: 65000,
    discountedPrice: 58999,
    stock: 8,
    thumbnailUrl: 'https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Premium 17-inch sport alloy wheel rims, set of 4.',
    features: '17" diameter, gloss black finish, 5-spoke sport design, universal PCD.',
    tags: ['alloy-rims', '17-inch'],
    featured: true,
  },
  {
    name: 'Performance Cold Air Intake Kit',
    category: 'Wheels & Performance',
    subCategory: 'Cold Air Intake',
    price: 15500,
    discountedPrice: 13999,
    stock: 18,
    thumbnailUrl: 'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'High-flow cold air intake kit for improved horsepower and throttle response.',
    features: 'Mandrel-bent aluminum tube, washable high-flow filter, heat shield, universal fit.',
    tags: ['cold-air-intake', 'performance'],
  },
  {
    name: 'Stainless Steel Exhaust Tip - Dual Outlet',
    category: 'Wheels & Performance',
    subCategory: 'Exhaust Systems',
    price: 4500,
    discountedPrice: 3799,
    stock: 35,
    thumbnailUrl: 'https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Polished stainless steel dual-outlet exhaust tip for a sporty exhaust note.',
    features: '304 stainless steel, dual 3" outlets, bolt-on clamp, fits 2.0-2.5" pipes, mirror polish.',
    tags: ['exhaust-tip', 'stainless-steel'],
  },
  {
    name: 'High-Flow Performance Air Filter',
    category: 'Wheels & Performance',
    subCategory: 'Sports Filters',
    price: 3800,
    discountedPrice: 3299,
    stock: 50,
    thumbnailUrl: 'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Washable and reusable high-flow air filter for 10% more airflow over stock.',
    features: 'Cotton gauze media, washable & reusable, +10% airflow, million-mile warranty.',
    tags: ['air-filter', 'high-flow', 'performance'],
  },
  {
    name: 'Sport Lowering Springs Kit - 30mm Drop',
    category: 'Wheels & Performance',
    subCategory: 'Suspension Kits',
    price: 18000,
    discountedPrice: 15999,
    stock: 12,
    thumbnailUrl: 'https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Progressive-rate lowering springs for improved stance and handling.',
    features: '30mm front / 25mm rear drop, progressive rate, spring steel, set of 4.',
    tags: ['lowering-springs', 'suspension'],
  },
  {
    name: 'Universal Chrome Wheel Caps - Set of 4',
    category: 'Wheels & Performance',
    subCategory: 'Wheel Caps',
    price: 1200,
    stock: 120,
    thumbnailUrl: 'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Chrome-finished center wheel caps for a clean, OEM-plus look.',
    features: '60mm outer diameter, snap-fit, chrome ABS, fits most 5-lug wheels, set of 4.',
    tags: ['wheel-cap', 'chrome', 'center-cap'],
  },

  // ====== Electronics & Security (6) ======
  {
    name: 'Full HD Dash Cam with Night Vision',
    category: 'Electronics & Security',
    subCategory: 'Dash Cams',
    price: 8500,
    discountedPrice: 7499,
    stock: 35,
    thumbnailUrl: 'https://images.unsplash.com/photo-1591488320449-011701bb6704?auto=format&fit=crop&w=800&q=80',
    shortDescription: '1080p Full HD dash cam with night vision and loop recording.',
    features: '1080p Full HD, 170Â° wide angle, night vision, G-sensor, loop recording, 32GB support.',
    tags: ['dash-cam', 'hd'],
    featured: true,
  },
  {
    name: 'JBL Car Subwoofer 1000W',
    category: 'Electronics & Security',
    subCategory: 'Subwoofers',
    price: 22000,
    discountedPrice: 19999,
    stock: 15,
    thumbnailUrl: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Powerful 1000W JBL car subwoofer for premium bass.',
    features: '1000W peak power, 12" cone, sealed enclosure, deep bass response.',
    tags: ['subwoofer', 'jbl', 'audio'],
  },
  {
    name: 'HD Reverse Camera with Parking Lines',
    category: 'Electronics & Security',
    subCategory: 'Reverse Cameras',
    price: 3500,
    discountedPrice: 2999,
    stock: 60,
    thumbnailUrl: 'https://images.unsplash.com/photo-1591488320449-011701bb6704?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Wide-angle HD reverse camera with dynamic parking guide lines.',
    features: '170Â° wide angle, IP68 waterproof, dynamic parking lines, night vision, universal mount.',
    tags: ['reverse-camera', 'parking'],
  },
  {
    name: '9-inch Android Car Stereo - Wireless CarPlay',
    category: 'Electronics & Security',
    subCategory: 'Car Stereos',
    price: 28000,
    discountedPrice: 24999,
    stock: 10,
    thumbnailUrl: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?auto=format&fit=crop&w=800&q=80',
    shortDescription: '9-inch touchscreen Android head unit with wireless CarPlay and Android Auto.',
    features: 'Android 13, wireless CarPlay/Android Auto, GPS navigation, Bluetooth 5.0, split screen.',
    tags: ['android-stereo', 'carplay', 'head-unit'],
  },
  {
    name: 'Magnetic Wireless Car Phone Charger Mount',
    category: 'Electronics & Security',
    subCategory: 'Phone Holders',
    price: 3200,
    discountedPrice: 2799,
    stock: 75,
    thumbnailUrl: 'https://images.unsplash.com/photo-1591488320449-011701bb6704?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'MagSafe-compatible magnetic wireless charger mount with 15W fast charging.',
    features: '15W Qi fast charge, MagSafe compatible, 360Â° rotation, vent + dash mount, auto-align.',
    tags: ['phone-charger', 'wireless', 'magsafe'],
  },
  {
    name: 'GPS Vehicle Tracker with Real-Time App',
    category: 'Electronics & Security',
    subCategory: 'GPS Trackers',
    price: 6500,
    discountedPrice: 5499,
    stock: 40,
    thumbnailUrl: 'https://images.unsplash.com/photo-1591488320449-011701bb6704?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Compact GPS tracker with real-time location, geo-fencing, and mobile app.',
    features: '4G LTE, real-time tracking, geo-fence alerts, 30-day battery, waterproof IP67, free app.',
    tags: ['gps-tracker', 'anti-theft', 'security'],
  },

  // ====== Bike Accessories (6) ======
  {
    name: 'Waterproof Motorcycle Body Cover - XL',
    category: 'Bike Accessories',
    subCategory: 'Bike Covers',
    price: 2500,
    stock: 50,
    thumbnailUrl: 'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Heavy-duty waterproof motorcycle body cover for outdoor protection.',
    features: '210D Oxford fabric, UV resistant, elastic hem, fits 150cc-250cc bikes.',
    tags: ['bike-cover', 'waterproof'],
    featured: true,
  },
  {
    name: 'Motorcycle LED Strip Lights Kit',
    category: 'Bike Accessories',
    subCategory: 'Bike LED Lights',
    price: 1200,
    stock: 100,
    thumbnailUrl: 'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'RGB LED strip light kit for motorcycle underbody and frame.',
    features: 'Multi-color RGB, remote controlled, waterproof, 12V, easy installation.',
    tags: ['bike-led', 'rgb'],
  },
  {
    name: 'Anti-Theft Motorcycle Disc Brake Lock',
    category: 'Bike Accessories',
    subCategory: 'Bike Locks',
    price: 1800,
    discountedPrice: 1499,
    stock: 70,
    thumbnailUrl: 'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Heavy-duty disc brake lock with 110dB alarm for motorcycle theft protection.',
    features: 'Hardened steel, 110dB alarm, 7mm locking pin, reminder cable included, 2 keys.',
    tags: ['disc-lock', 'alarm', 'anti-theft'],
  },
  {
    name: 'Gel Motorcycle Seat Cover - Universal',
    category: 'Bike Accessories',
    subCategory: 'Bike Seat Covers',
    price: 1500,
    discountedPrice: 1299,
    stock: 60,
    thumbnailUrl: 'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Breathable mesh gel seat cover for long-ride comfort on any motorcycle.',
    features: 'Honeycomb gel pad, anti-slip base, breathable mesh, fits most seat sizes, washable.',
    tags: ['seat-cover', 'gel', 'comfort'],
  },
  {
    name: 'Motorcycle Phone Mount - Handlebar Clamp',
    category: 'Bike Accessories',
    subCategory: 'Bike LED Lights',
    price: 1100,
    discountedPrice: 899,
    stock: 120,
    thumbnailUrl: 'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Vibration-dampened handlebar phone mount with 360Â° rotation.',
    features: 'Fits 4.7-7" phones, aluminium alloy clamp, anti-vibration pad, 360Â° rotation, tool-free install.',
    tags: ['phone-mount', 'handlebar', 'motorcycle'],
  },
  {
    name: 'Motorcycle Chain Cleaning & Lube Kit',
    category: 'Bike Accessories',
    subCategory: 'Bike Covers',
    price: 950,
    stock: 140,
    thumbnailUrl: 'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Complete chain maintenance kit with cleaner spray, chain lube, and brush.',
    features: 'Chain cleaner 250ml, chain lube 250ml, 3-sided cleaning brush, O-ring safe.',
    tags: ['chain-lube', 'chain-cleaner', 'maintenance'],
  },
];

async function seedProducts() {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/hamzaMobile';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Validate all categories exist
    const categoryNames = [...new Set(products.map((p) => p.category))];
    const foundCategories = await Category.find({ name: { $in: categoryNames } });
    const foundCatNames = new Set(foundCategories.map((c) => c.name));
    const missing = categoryNames.filter((n) => !foundCatNames.has(n));
    if (missing.length > 0) {
      console.warn('Warning: the following categories are not in DB:', missing);
      console.warn('Run `npm run seed:autocare-categories` first.');
    }

    // Cleanup: remove previously seeded products that don't match the new structure
    const currentSlugs = products.map((p) => slugify(p.name));
    const oldProductRemoved = await Product.deleteMany({
      slug: { $nin: currentSlugs },
      productType: 'single',
      // only remove products in our seeded categories to avoid touching user-created ones
      category: { $in: ['LED & Lighting', 'Exterior Accessories', 'Interior Accessories', 'Gadgets', 'Car Mats', 'Anti-Theft Locks', 'Alloy Rims & Wheels', 'Perfume & Fragrances', 'Mobile Accessories', 'Wiper Blades', 'Music & Stereo', 'Car Top Covers'] },
    });
    console.log(`Cleanup: removed ${oldProductRemoved.deletedCount} old seeded products`);

    let created = 0;
    let updated = 0;

    for (const p of products) {
      const slug = slugify(p.name);
      const payload = {
        ...p,
        slug,
        productType: 'single',
        displayOn: 'both',
        status: 'published',
        variants: [],
        featured: p.featured === true,
      };

      const existing = await Product.findOne({ slug });
      if (existing) {
        await Product.findByIdAndUpdate(existing._id, payload);
        console.log(`Updated: ${p.name}${p.featured ? ' [FEATURED]' : ''}`);
        updated++;
      } else {
        await Product.create(payload);
        console.log(`Created: ${p.name}${p.featured ? ' [FEATURED]' : ''}`);
        created++;
      }
    }

    const featuredCount = products.filter((p) => p.featured).length;
    const categoryCount = new Set(products.map((p) => p.category)).size;

    console.log('\n========================================');
    console.log('Products seeded successfully!');
    console.log(`Created: ${created}`);
    console.log(`Updated: ${updated}`);
    console.log(`Total: ${products.length} (6 per category Ã— ${categoryCount} categories)`);
    console.log(`Featured: ${featuredCount}`);
    console.log('========================================\n');

    const total = await Product.countDocuments();
    console.log(`Total products in DB: ${total}`);
  } catch (error) {
    console.error('Error seeding products:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

seedProducts();
