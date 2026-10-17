// src/seeds/seedCarHierarchy.js
//
// Seeds the hierarchical car catalog (CarMake â†’ CarModel â†’ CarVariant).
// Idempotent: safe to re-run. Existing (make, model, variant, year range)
// combinations are skipped; new ones are added.
//
// Comprehensive Pakistan market coverage:
//   â€¢ Locally assembled vehicles
//   â€¢ Officially imported (CBU) vehicles
//   â€¢ Popular JDM / grey-market imports
//   â€¢ Luxury & premium imports
//
// Logo URLs use the public carlogos.org brand library (stable, free, no auth).

const mongoose = require('mongoose');
require('dotenv').config();

const CarMake = require('../models/carMake');
const CarModel = require('../models/carModel');
const CarVariant = require('../models/carVariant');

const titleCase = (str) => {
  const s = String(str || '').trim();
  if (!s) return s;
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
};

const LOGO_BASE = 'https://www.carlogos.org/car-logos';

/**
 * Master seed data â€” structured as Make â†’ Models â†’ Variants.
 * Each variant has a year range (yearStart â†’ yearEnd).
 */
const data = [
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // LOCALLY ASSEMBLED / OFFICIALLY SOLD IN PAKISTAN
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ TOYOTA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Toyota',
    logo: `${LOGO_BASE}/toyota-logo.png`,
    models: [
      {
        name: 'Corolla',
        variants: [
          { name: 'XLi 1.3 MT', yearStart: 2015, yearEnd: 2021 },
          { name: 'XLi 1.3 AT', yearStart: 2015, yearEnd: 2021 },
          { name: 'GLi 1.3 MT', yearStart: 2015, yearEnd: 2021 },
          { name: 'GLi 1.3 AT', yearStart: 2015, yearEnd: 2021 },
          { name: 'GLi 1.6', yearStart: 2015, yearEnd: 2025 },
          { name: 'Altis 1.6 MT', yearStart: 2015, yearEnd: 2025 },
          { name: 'Altis 1.6 CVT', yearStart: 2015, yearEnd: 2025 },
          { name: 'Altis Grande 1.8 CVT', yearStart: 2015, yearEnd: 2025 },
          { name: 'Altis X 1.6 CVT', yearStart: 2021, yearEnd: 2025 },
          { name: 'Altis X 1.8 CVT', yearStart: 2022, yearEnd: 2025 },
          { name: 'SE 1.2T CVT', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Yaris',
        variants: [
          { name: 'GLi MT 1.3', yearStart: 2020, yearEnd: 2025 },
          { name: 'GLi CVT 1.3', yearStart: 2020, yearEnd: 2025 },
          { name: 'ATIV MT 1.3', yearStart: 2020, yearEnd: 2025 },
          { name: 'ATIV CVT 1.3', yearStart: 2020, yearEnd: 2025 },
          { name: 'ATIV X MT 1.5', yearStart: 2020, yearEnd: 2025 },
          { name: 'ATIV X CVT 1.5', yearStart: 2020, yearEnd: 2025 },
          { name: 'Aero 1.5 CVT', yearStart: 2023, yearEnd: 2025 },
        ],
      },
      {
        name: 'Corolla Cross',
        variants: [
          { name: 'Smart 1.8', yearStart: 2024, yearEnd: 2026 },
          { name: 'HEV 1.8', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Raize',
        variants: [
          { name: '1.0T CVT', yearStart: 2024, yearEnd: 2026 },
          { name: '1.2 CVT', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Hilux',
        variants: [
          { name: 'Single Cab 2.5 Diesel', yearStart: 2016, yearEnd: 2020 },
          { name: 'E 2.5 Diesel', yearStart: 2016, yearEnd: 2020 },
          { name: 'Revo G 2.8 Diesel', yearStart: 2016, yearEnd: 2026 },
          { name: 'Revo V 2.8 Diesel', yearStart: 2016, yearEnd: 2026 },
          { name: 'Revo Rocco 2.8 Diesel', yearStart: 2018, yearEnd: 2026 },
          { name: 'Revo GR Sport 2.8 Diesel', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Fortuner',
        variants: [
          { name: 'G 2.7 Petrol', yearStart: 2016, yearEnd: 2026 },
          { name: 'V 2.8 Diesel', yearStart: 2016, yearEnd: 2026 },
          { name: 'Sigma 4 2.7 Petrol', yearStart: 2018, yearEnd: 2026 },
          { name: 'Legender 2.8 Diesel', yearStart: 2021, yearEnd: 2026 },
          { name: 'GR-S 2.8 Diesel', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Land Cruiser',
        variants: [
          { name: 'VX 4.5 Diesel V8', yearStart: 2015, yearEnd: 2021 },
          { name: 'ZX 4.5 Diesel V8', yearStart: 2015, yearEnd: 2021 },
          { name: 'GX 4.0 V6', yearStart: 2015, yearEnd: 2021 },
          { name: 'LC300 GR-S 3.3 Diesel', yearStart: 2022, yearEnd: 2026 },
          { name: 'LC300 ZX 3.3 Diesel', yearStart: 2022, yearEnd: 2026 },
          { name: 'LC300 VX 3.3 Diesel', yearStart: 2022, yearEnd: 2026 },
          { name: 'LC300 3.5 Twin Turbo', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'Land Cruiser 70',
        variants: [
          { name: 'HZJ76 4.2 Diesel', yearStart: 2015, yearEnd: 2026 },
          { name: 'VDJ76 4.5 V8 Diesel', yearStart: 2015, yearEnd: 2026 },
          { name: 'VDJ79 4.5 V8 Diesel Pickup', yearStart: 2015, yearEnd: 2026 },
        ],
      },
      {
        name: 'Prado',
        variants: [
          { name: 'TX 2.7', yearStart: 2015, yearEnd: 2024 },
          { name: 'TXL 2.7', yearStart: 2015, yearEnd: 2024 },
          { name: 'TX 3.0 Diesel', yearStart: 2015, yearEnd: 2024 },
          { name: 'TZ-G 4.0 V6', yearStart: 2015, yearEnd: 2024 },
          { name: 'TX 2.8 Diesel (250 Series)', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Camry',
        variants: [
          { name: '2.5 G', yearStart: 2018, yearEnd: 2026 },
          { name: '2.5 Hybrid', yearStart: 2020, yearEnd: 2026 },
          { name: '2.5 LE', yearStart: 2018, yearEnd: 2024 },
        ],
      },
      {
        name: 'Hiace',
        variants: [
          { name: 'Standard 2.5 Diesel', yearStart: 2015, yearEnd: 2018 },
          { name: 'GL 2.8 Diesel', yearStart: 2018, yearEnd: 2026 },
          { name: 'Grand Cabin 2.7', yearStart: 2018, yearEnd: 2026 },
          { name: 'Commuter 2.8 Diesel', yearStart: 2018, yearEnd: 2026 },
          { name: 'DX 2.8 Diesel', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'Coaster',
        variants: [
          { name: 'Standard 4.2 Diesel', yearStart: 2015, yearEnd: 2024 },
          { name: 'High Roof 4.2 Diesel', yearStart: 2015, yearEnd: 2024 },
          { name: 'Standard 4.0 V6', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'Avanza',
        variants: [
          { name: '1.5 G', yearStart: 2015, yearEnd: 2022 },
          { name: '1.3 E', yearStart: 2015, yearEnd: 2022 },
        ],
      },
      {
        name: 'Rush',
        variants: [{ name: 'G 1.5', yearStart: 2018, yearEnd: 2023 }],
      },
      {
        name: 'bZ4X',
        variants: [{ name: 'EV AWD', yearStart: 2024, yearEnd: 2026 }],
      },
      // Popular JDM imports
      {
        name: 'Aqua',
        variants: [
          { name: 'S 1.5 Hybrid', yearStart: 2015, yearEnd: 2023 },
          { name: 'G 1.5 Hybrid', yearStart: 2015, yearEnd: 2023 },
          { name: 'Crossover 1.5 Hybrid', yearStart: 2018, yearEnd: 2023 },
          { name: 'Z 1.5 Hybrid (2nd Gen)', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'Vitz',
        variants: [
          { name: 'F 1.0', yearStart: 2015, yearEnd: 2019 },
          { name: 'F 1.3', yearStart: 2015, yearEnd: 2019 },
          { name: 'Jewela 1.0', yearStart: 2016, yearEnd: 2019 },
          { name: 'U 1.0', yearStart: 2015, yearEnd: 2019 },
          { name: 'Hybrid 1.5', yearStart: 2017, yearEnd: 2019 },
        ],
      },
      {
        name: 'Prius',
        variants: [
          { name: 'S 1.8 Hybrid', yearStart: 2016, yearEnd: 2023 },
          { name: 'A 1.8 Hybrid', yearStart: 2016, yearEnd: 2023 },
          { name: 'S Touring 1.8 Hybrid', yearStart: 2016, yearEnd: 2023 },
          { name: 'PHV 1.8 PHEV', yearStart: 2017, yearEnd: 2023 },
        ],
      },
      {
        name: 'Passo',
        variants: [
          { name: 'X 1.0', yearStart: 2015, yearEnd: 2023 },
          { name: 'XS 1.0', yearStart: 2016, yearEnd: 2023 },
          { name: 'Moda 1.0', yearStart: 2016, yearEnd: 2023 },
        ],
      },
      {
        name: 'C-HR',
        variants: [
          { name: 'G-T 1.2 Turbo', yearStart: 2017, yearEnd: 2023 },
          { name: 'S 1.8 Hybrid', yearStart: 2017, yearEnd: 2023 },
          { name: 'G 1.8 Hybrid', yearStart: 2017, yearEnd: 2023 },
        ],
      },
      {
        name: 'Crown',
        variants: [
          { name: 'Athlete 2.5', yearStart: 2015, yearEnd: 2020 },
          { name: 'Athlete S 3.5', yearStart: 2015, yearEnd: 2020 },
          { name: 'Athlete G 2.5 Hybrid', yearStart: 2015, yearEnd: 2020 },
          { name: 'Royal Saloon 2.5', yearStart: 2015, yearEnd: 2020 },
          { name: 'Crossover 2.5 Hybrid', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Mark X',
        variants: [
          { name: '250G 2.5', yearStart: 2013, yearEnd: 2019 },
          { name: '250S 2.5', yearStart: 2013, yearEnd: 2019 },
          { name: '350S 3.5', yearStart: 2013, yearEnd: 2019 },
        ],
      },
      {
        name: 'Noah',
        variants: [
          { name: 'Si 2.0', yearStart: 2017, yearEnd: 2022 },
          { name: 'Hybrid Si 1.8', yearStart: 2017, yearEnd: 2022 },
          { name: 'S-Z 2.0 (4th Gen)', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'Voxy',
        variants: [
          { name: 'ZS 2.0', yearStart: 2017, yearEnd: 2022 },
          { name: 'Hybrid V 1.8', yearStart: 2017, yearEnd: 2022 },
          { name: 'S-Z 2.0 (4th Gen)', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'Alphard',
        variants: [
          { name: '2.5 S', yearStart: 2018, yearEnd: 2023 },
          { name: '3.5 Executive Lounge', yearStart: 2018, yearEnd: 2023 },
          { name: '2.5 Hybrid', yearStart: 2018, yearEnd: 2023 },
          { name: 'Z 2.5 (4th Gen)', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Vellfire',
        variants: [
          { name: '2.5 Z', yearStart: 2018, yearEnd: 2023 },
          { name: '3.5 ZG', yearStart: 2018, yearEnd: 2023 },
          { name: '2.5 Hybrid', yearStart: 2018, yearEnd: 2023 },
        ],
      },
      {
        name: 'Tank',
        variants: [
          { name: 'X 1.0 Turbo', yearStart: 2016, yearEnd: 2020 },
          { name: 'Custom G-T 1.0 Turbo', yearStart: 2016, yearEnd: 2020 },
        ],
      },
      {
        name: 'Roomy',
        variants: [
          { name: 'X 1.0', yearStart: 2016, yearEnd: 2023 },
          { name: 'Custom G-T 1.0 Turbo', yearStart: 2016, yearEnd: 2023 },
        ],
      },
      {
        name: 'Harrier',
        variants: [
          { name: 'Premium 2.0', yearStart: 2015, yearEnd: 2020 },
          { name: 'Z 2.0 (4th Gen)', yearStart: 2020, yearEnd: 2026 },
          { name: 'Z 2.5 Hybrid (4th Gen)', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'RAV4',
        variants: [
          { name: '2.0 G', yearStart: 2019, yearEnd: 2026 },
          { name: '2.5 Hybrid', yearStart: 2019, yearEnd: 2026 },
          { name: '2.5 PHEV', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'GR Yaris',
        variants: [{ name: '1.6 Turbo AWD', yearStart: 2021, yearEnd: 2026 }],
      },
      {
        name: 'GR86',
        variants: [{ name: '2.4 RWD', yearStart: 2022, yearEnd: 2026 }],
      },
      {
        name: '86',
        variants: [{ name: 'GT 2.0', yearStart: 2015, yearEnd: 2021 }],
      },
      {
        name: 'Supra',
        variants: [
          { name: 'SZ-R 2.0 Turbo', yearStart: 2019, yearEnd: 2026 },
          { name: 'RZ 3.0 Turbo', yearStart: 2019, yearEnd: 2026 },
        ],
      },
      {
        name: 'Dyna',
        variants: [
          { name: '150 3.0 Diesel', yearStart: 2015, yearEnd: 2024 },
          { name: '200 4.0 Diesel', yearStart: 2015, yearEnd: 2024 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ HONDA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Honda',
    logo: `${LOGO_BASE}/honda-logo.png`,
    models: [
      {
        name: 'Civic',
        variants: [
          { name: 'VTi 1.8 MT', yearStart: 2016, yearEnd: 2021 },
          { name: 'VTi 1.8 AT', yearStart: 2016, yearEnd: 2021 },
          { name: 'VTi Oriel 1.8', yearStart: 2016, yearEnd: 2021 },
          { name: 'Oriel Prosmatec UG 1.8', yearStart: 2019, yearEnd: 2021 },
          { name: 'RS Turbo 1.5', yearStart: 2019, yearEnd: 2025 },
          { name: '11th Gen LX 2.0', yearStart: 2022, yearEnd: 2026 },
          { name: '11th Gen EX 2.0', yearStart: 2022, yearEnd: 2026 },
          { name: '11th Gen Oriel 1.5T', yearStart: 2022, yearEnd: 2026 },
          { name: '11th Gen RS 1.5T', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'City',
        variants: [
          { name: '1.3 i-VTEC MT', yearStart: 2015, yearEnd: 2021 },
          { name: '1.3 i-VTEC Prosmatec', yearStart: 2015, yearEnd: 2021 },
          { name: '1.5 Aspire MT', yearStart: 2015, yearEnd: 2021 },
          { name: '1.5 Aspire Prosmatec', yearStart: 2015, yearEnd: 2021 },
          { name: '1.2 MT (7th Gen)', yearStart: 2022, yearEnd: 2026 },
          { name: '1.2 CVT (7th Gen)', yearStart: 2022, yearEnd: 2026 },
          { name: '1.5 Aspire MT (7th Gen)', yearStart: 2022, yearEnd: 2026 },
          { name: '1.5 Aspire CVT (7th Gen)', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'BR-V',
        variants: [
          { name: 'i-VTEC S 1.5 MT', yearStart: 2017, yearEnd: 2021 },
          { name: 'i-VTEC S 1.5 AT', yearStart: 2017, yearEnd: 2021 },
          { name: 'i-VTEC VX 1.5', yearStart: 2017, yearEnd: 2021 },
          { name: 'S CVT 1.5 (2nd Gen)', yearStart: 2022, yearEnd: 2026 },
          { name: 'VX CVT 1.5 (2nd Gen)', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'HR-V',
        variants: [
          { name: 'VTi 1.8', yearStart: 2022, yearEnd: 2026 },
          { name: 'VTi-S 1.8', yearStart: 2022, yearEnd: 2026 },
          { name: 'e:HEV 1.5 Hybrid', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'WR-V',
        variants: [
          { name: 'S 1.5', yearStart: 2024, yearEnd: 2026 },
          { name: 'VX 1.5', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'CR-V',
        variants: [
          { name: '2.0 EX', yearStart: 2015, yearEnd: 2022 },
          { name: '1.5T VTi-S', yearStart: 2018, yearEnd: 2024 },
          { name: '2.0 Hybrid (6th Gen)', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Accord',
        variants: [
          { name: 'Sport 1.5 Turbo', yearStart: 2018, yearEnd: 2024 },
          { name: 'Touring 2.0 Turbo', yearStart: 2018, yearEnd: 2024 },
          { name: '2.0 Hybrid (11th Gen)', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      // Popular JDM imports
      {
        name: 'Vezel',
        variants: [
          { name: 'Hybrid X 1.5', yearStart: 2016, yearEnd: 2022 },
          { name: 'Hybrid Z 1.5', yearStart: 2016, yearEnd: 2022 },
          { name: 'RS 1.5', yearStart: 2018, yearEnd: 2022 },
          { name: 'e:HEV Z (2nd Gen)', yearStart: 2021, yearEnd: 2026 },
          { name: 'e:HEV PLaY (2nd Gen)', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'Fit',
        variants: [
          { name: 'Hybrid 1.5', yearStart: 2015, yearEnd: 2021 },
          { name: '13G 1.3', yearStart: 2015, yearEnd: 2021 },
          { name: '15XL 1.5', yearStart: 2015, yearEnd: 2021 },
          { name: 'Home 1.3 (4th Gen)', yearStart: 2020, yearEnd: 2026 },
          { name: 'e:HEV Home (4th Gen)', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'Freed',
        variants: [
          { name: 'G 1.5', yearStart: 2016, yearEnd: 2023 },
          { name: 'Hybrid G 1.5', yearStart: 2016, yearEnd: 2023 },
          { name: 'Hybrid EX 1.5', yearStart: 2016, yearEnd: 2023 },
        ],
      },
      {
        name: 'Grace',
        variants: [
          { name: 'LX 1.5', yearStart: 2015, yearEnd: 2020 },
          { name: 'Hybrid LX 1.5', yearStart: 2015, yearEnd: 2020 },
          { name: 'Hybrid EX 1.5', yearStart: 2015, yearEnd: 2020 },
        ],
      },
      {
        name: 'Shuttle',
        variants: [
          { name: 'G 1.5', yearStart: 2015, yearEnd: 2022 },
          { name: 'Hybrid Z 1.5', yearStart: 2015, yearEnd: 2022 },
        ],
      },
      {
        name: 'N-WGN',
        variants: [
          { name: 'G 660', yearStart: 2016, yearEnd: 2023 },
          { name: 'L 660', yearStart: 2016, yearEnd: 2023 },
          { name: 'Custom G Turbo 660', yearStart: 2019, yearEnd: 2023 },
        ],
      },
      {
        name: 'N-Box',
        variants: [
          { name: 'G 660', yearStart: 2016, yearEnd: 2023 },
          { name: 'G-L 660', yearStart: 2016, yearEnd: 2023 },
          { name: 'Custom G-L 660', yearStart: 2016, yearEnd: 2023 },
          { name: 'Custom G-L Turbo 660', yearStart: 2017, yearEnd: 2023 },
        ],
      },
      {
        name: 'N-One',
        variants: [
          { name: 'Standard G 660', yearStart: 2017, yearEnd: 2023 },
          { name: 'Premium 660', yearStart: 2017, yearEnd: 2023 },
          { name: 'RS 660 Turbo', yearStart: 2020, yearEnd: 2023 },
        ],
      },
      {
        name: 'S660',
        variants: [
          { name: 'Alpha 660 Turbo', yearStart: 2015, yearEnd: 2022 },
          { name: 'Beta 660 Turbo', yearStart: 2015, yearEnd: 2022 },
        ],
      },
      {
        name: 'Stepwgn',
        variants: [
          { name: 'Spada 1.5 Turbo', yearStart: 2015, yearEnd: 2022 },
          { name: 'Spada Hybrid 2.0', yearStart: 2017, yearEnd: 2022 },
          { name: 'Air 2.0 (6th Gen)', yearStart: 2022, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ SUZUKI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Suzuki',
    logo: `${LOGO_BASE}/suzuki-logo.png`,
    models: [
      {
        name: 'Alto',
        variants: [
          { name: 'VX 660', yearStart: 2019, yearEnd: 2026 },
          { name: 'VXR 660', yearStart: 2019, yearEnd: 2026 },
          { name: 'VXL AGS 660', yearStart: 2019, yearEnd: 2026 },
        ],
      },
      {
        name: 'Cultus',
        variants: [
          { name: 'VXR 1.0', yearStart: 2017, yearEnd: 2025 },
          { name: 'VXL 1.0', yearStart: 2017, yearEnd: 2025 },
          { name: 'AGS 1.0', yearStart: 2019, yearEnd: 2025 },
        ],
      },
      {
        name: 'Wagon R',
        variants: [
          { name: 'VXR 1.0', yearStart: 2014, yearEnd: 2025 },
          { name: 'VXL 1.0', yearStart: 2014, yearEnd: 2025 },
          { name: 'AGS 1.0', yearStart: 2018, yearEnd: 2025 },
        ],
      },
      {
        name: 'Swift',
        variants: [
          { name: 'DLX 1.3 MT (Old)', yearStart: 2010, yearEnd: 2021 },
          { name: 'GL MT 1.2 (4th Gen)', yearStart: 2022, yearEnd: 2026 },
          { name: 'GL CVT 1.2 (4th Gen)', yearStart: 2022, yearEnd: 2026 },
          { name: 'GLX CVT 1.2 (4th Gen)', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'Ciaz',
        variants: [
          { name: 'GL MT 1.4', yearStart: 2017, yearEnd: 2021 },
          { name: 'GLX AT 1.4', yearStart: 2017, yearEnd: 2021 },
        ],
      },
      {
        name: 'Bolan',
        variants: [
          { name: 'Cargo Van', yearStart: 2010, yearEnd: 2026 },
          { name: 'VX Hiroof', yearStart: 2010, yearEnd: 2026 },
        ],
      },
      {
        name: 'Ravi',
        variants: [
          { name: 'Standard 800', yearStart: 2010, yearEnd: 2026 },
          { name: 'VXR 800', yearStart: 2015, yearEnd: 2026 },
        ],
      },
      {
        name: 'Mehran',
        variants: [
          { name: 'VX 800', yearStart: 2010, yearEnd: 2019 },
          { name: 'VXR 800', yearStart: 2010, yearEnd: 2019 },
        ],
      },
      {
        name: 'Jimny',
        variants: [
          { name: 'JLX 1.3 (Old)', yearStart: 2015, yearEnd: 2018 },
          { name: 'Sierra 1.5 (4th Gen)', yearStart: 2019, yearEnd: 2026 },
          { name: 'GL 1.5 (4th Gen)', yearStart: 2019, yearEnd: 2026 },
          { name: '5-Door 1.5', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Vitara',
        variants: [
          { name: 'GLX 1.6', yearStart: 2015, yearEnd: 2020 },
        ],
      },
      {
        name: 'APV',
        variants: [
          { name: 'GLX 1.5', yearStart: 2010, yearEnd: 2021 },
        ],
      },
      // JDM imports
      {
        name: 'Every',
        variants: [
          { name: 'GA 660', yearStart: 2016, yearEnd: 2023 },
          { name: 'PC 660', yearStart: 2016, yearEnd: 2023 },
          { name: 'Landy 660', yearStart: 2018, yearEnd: 2023 },
          { name: 'Wagon PZ Turbo 660', yearStart: 2017, yearEnd: 2023 },
        ],
      },
      {
        name: 'Hustler',
        variants: [
          { name: 'G 660', yearStart: 2018, yearEnd: 2023 },
          { name: 'J Style 660', yearStart: 2018, yearEnd: 2023 },
          { name: 'X Turbo 660', yearStart: 2020, yearEnd: 2023 },
        ],
      },
      {
        name: 'Spacia',
        variants: [
          { name: 'Hybrid G 660', yearStart: 2018, yearEnd: 2023 },
          { name: 'Custom 660', yearStart: 2018, yearEnd: 2023 },
          { name: 'Custom Hybrid XS Turbo 660', yearStart: 2018, yearEnd: 2023 },
        ],
      },
      {
        name: 'Alto Lapin',
        variants: [
          { name: 'G 660', yearStart: 2016, yearEnd: 2022 },
          { name: 'X 660', yearStart: 2016, yearEnd: 2022 },
          { name: 'S 660', yearStart: 2016, yearEnd: 2022 },
        ],
      },
      {
        name: 'Carry',
        variants: [
          { name: 'KC 660', yearStart: 2015, yearEnd: 2023 },
          { name: 'KX 660', yearStart: 2015, yearEnd: 2023 },
        ],
      },
      {
        name: 'XBee',
        variants: [
          { name: 'Hybrid MZ 1.0 Turbo', yearStart: 2018, yearEnd: 2022 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ HYUNDAI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Hyundai',
    logo: `${LOGO_BASE}/hyundai-logo.png`,
    models: [
      {
        name: 'Tucson',
        variants: [
          { name: 'GLS Sport FWD 2.0', yearStart: 2021, yearEnd: 2026 },
          { name: 'Ultimate AWD 2.0', yearStart: 2021, yearEnd: 2026 },
          { name: '2.0 CRDi Diesel', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'Elantra',
        variants: [
          { name: 'GLS 1.6', yearStart: 2021, yearEnd: 2026 },
          { name: 'GLS 2.0', yearStart: 2021, yearEnd: 2026 },
          { name: 'N-Line 1.6T', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'Sonata',
        variants: [
          { name: 'GLS 2.0', yearStart: 2021, yearEnd: 2026 },
          { name: 'GLS 2.5', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'Venue',
        variants: [
          { name: 'GL 1.6', yearStart: 2023, yearEnd: 2026 },
          { name: 'GLS 1.6', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Creta',
        variants: [
          { name: 'GL 1.5', yearStart: 2024, yearEnd: 2026 },
          { name: 'GLS 1.5', yearStart: 2024, yearEnd: 2026 },
          { name: 'Ultimate 1.5 Turbo', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Santa Fe',
        variants: [
          { name: 'Signature 2.5', yearStart: 2023, yearEnd: 2026 },
          { name: '2.5 Turbo AWD', yearStart: 2023, yearEnd: 2026 },
          { name: 'Calligraphy 2.5T', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Palisade',
        variants: [
          { name: '3.8 V6 AWD', yearStart: 2023, yearEnd: 2026 },
          { name: 'Calligraphy 3.8 V6', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Porter H-100',
        variants: [
          { name: '2.5 CRDi Diesel', yearStart: 2020, yearEnd: 2026 },
          { name: '2.6 CRDi Diesel', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'Mighty',
        variants: [
          { name: 'EX 3.9 Diesel Truck', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'Staria',
        variants: [
          { name: 'Premium 2.2 CRDi', yearStart: 2023, yearEnd: 2026 },
          { name: 'Lounge 2.2 CRDi', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Ioniq 5',
        variants: [
          { name: 'Long Range RWD', yearStart: 2023, yearEnd: 2026 },
          { name: 'Long Range AWD', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Ioniq 6',
        variants: [
          { name: 'Long Range RWD', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Grandeur / Azera',
        variants: [
          { name: '3.3 V6', yearStart: 2017, yearEnd: 2023 },
          { name: '3.5 V6 (7th Gen)', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Accent',
        variants: [
          { name: '1.4 GL', yearStart: 2012, yearEnd: 2018 },
          { name: '1.6 GLS', yearStart: 2012, yearEnd: 2018 },
        ],
      },
      {
        name: 'Grand Starex / H-1',
        variants: [
          { name: '2.5 CRDi GLS', yearStart: 2015, yearEnd: 2021 },
          { name: '2.5 CRDi Wagon', yearStart: 2015, yearEnd: 2021 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ KIA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Kia',
    logo: `${LOGO_BASE}/kia-logo.png`,
    models: [
      {
        name: 'Sportage',
        variants: [
          { name: 'Alpha FWD 2.0', yearStart: 2019, yearEnd: 2026 },
          { name: 'FWD 2.0', yearStart: 2019, yearEnd: 2026 },
          { name: 'AWD 2.0', yearStart: 2019, yearEnd: 2026 },
          { name: 'Black Edition', yearStart: 2022, yearEnd: 2026 },
          { name: 'FHEV AWD 1.6 Turbo', yearStart: 2023, yearEnd: 2026 },
          { name: 'Gravity 2.0', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Picanto',
        variants: [
          { name: 'Manual 1.0', yearStart: 2019, yearEnd: 2025 },
          { name: 'Automatic 1.0', yearStart: 2019, yearEnd: 2025 },
        ],
      },
      {
        name: 'Stonic',
        variants: [
          { name: 'EX 1.4', yearStart: 2021, yearEnd: 2026 },
          { name: 'EX+ 1.4', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'Pegas',
        variants: [
          { name: '1.4 MT', yearStart: 2022, yearEnd: 2026 },
          { name: '1.4 AT', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'Cerato / Forte',
        variants: [
          { name: 'EX 2.0', yearStart: 2019, yearEnd: 2024 },
          { name: 'GT-Line 1.6T', yearStart: 2019, yearEnd: 2024 },
        ],
      },
      {
        name: 'K5 / Optima',
        variants: [
          { name: 'EX 2.0', yearStart: 2020, yearEnd: 2026 },
          { name: 'GT-Line 1.6T', yearStart: 2020, yearEnd: 2026 },
          { name: '2.5 GT', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'Sorento',
        variants: [
          { name: '2.4 FWD', yearStart: 2020, yearEnd: 2026 },
          { name: '2.4 AWD', yearStart: 2020, yearEnd: 2026 },
          { name: '3.5 V6 AWD', yearStart: 2021, yearEnd: 2026 },
          { name: '2.5T AWD', yearStart: 2022, yearEnd: 2026 },
          { name: 'HEV 1.6T', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Carnival',
        variants: [
          { name: 'EX 3.5 V6', yearStart: 2022, yearEnd: 2026 },
          { name: 'SX 3.5 V6', yearStart: 2022, yearEnd: 2026 },
          { name: 'SX Prestige 3.5 V6', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Seltos',
        variants: [
          { name: 'EX 1.6', yearStart: 2024, yearEnd: 2026 },
          { name: 'SX 1.6 Turbo', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Niro',
        variants: [
          { name: 'HEV 1.6', yearStart: 2023, yearEnd: 2026 },
          { name: 'PHEV 1.6', yearStart: 2023, yearEnd: 2026 },
          { name: 'EV', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Telluride',
        variants: [
          { name: 'EX 3.8 V6', yearStart: 2023, yearEnd: 2026 },
          { name: 'SX 3.8 V6 AWD', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'EV6',
        variants: [
          { name: 'GT-Line RWD', yearStart: 2023, yearEnd: 2026 },
          { name: 'GT-Line AWD', yearStart: 2023, yearEnd: 2026 },
          { name: 'GT AWD', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'EV9',
        variants: [
          { name: 'GT-Line AWD', yearStart: 2024, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ MG â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'MG',
    logo: `${LOGO_BASE}/mg-logo.png`,
    models: [
      {
        name: 'HS',
        variants: [
          { name: 'Core 1.5T', yearStart: 2020, yearEnd: 2026 },
          { name: 'Excite 1.5T', yearStart: 2020, yearEnd: 2026 },
          { name: 'Essence 1.5T', yearStart: 2020, yearEnd: 2026 },
          { name: 'PHEV 1.5T', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'ZS',
        variants: [
          { name: 'Excite 1.5', yearStart: 2022, yearEnd: 2026 },
          { name: 'Luxury 1.5', yearStart: 2022, yearEnd: 2026 },
          { name: 'Alpha 1.5', yearStart: 2022, yearEnd: 2026 },
          { name: 'EV Standard Range', yearStart: 2023, yearEnd: 2026 },
          { name: 'EV Long Range', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'MG 3',
        variants: [
          { name: 'Core 1.5', yearStart: 2023, yearEnd: 2026 },
          { name: 'Excite 1.5', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'MG GT',
        variants: [
          { name: 'Core 1.5T', yearStart: 2023, yearEnd: 2026 },
          { name: 'Excite 1.5T', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'RX8',
        variants: [
          { name: '2.0T AWD', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'One',
        variants: [
          { name: 'Alpha 1.5T', yearStart: 2023, yearEnd: 2026 },
          { name: 'Trophy 1.5T', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'MG 4',
        variants: [
          { name: 'EV Excite', yearStart: 2024, yearEnd: 2026 },
          { name: 'EV Trophy Long Range', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'MG 5',
        variants: [
          { name: 'EV Excite', yearStart: 2024, yearEnd: 2026 },
          { name: 'EV Trophy Long Range', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'MG 7',
        variants: [
          { name: 'Trophy 2.0T', yearStart: 2024, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ CHANGAN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Changan',
    logo: `${LOGO_BASE}/changan-logo.png`,
    models: [
      {
        name: 'Alsvin',
        variants: [
          { name: 'Comfort MT 1.5', yearStart: 2021, yearEnd: 2026 },
          { name: 'Comfort DCT 1.5', yearStart: 2021, yearEnd: 2026 },
          { name: 'Lumiere DCT 1.5', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'Oshan X7',
        variants: [
          { name: 'Comfort 1.5T DCT', yearStart: 2022, yearEnd: 2026 },
          { name: 'FutureSense 1.5T DCT', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'UNI-T',
        variants: [
          { name: 'Comfort 1.5T', yearStart: 2023, yearEnd: 2026 },
          { name: 'FutureSense 1.5T', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'UNI-K',
        variants: [
          { name: 'Comfort 2.0T', yearStart: 2023, yearEnd: 2026 },
          { name: 'Premium 2.0T AWD', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'UNI-V',
        variants: [
          { name: '1.5T DCT', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'UNI-S',
        variants: [
          { name: '1.5T DCT', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'CS35 Plus',
        variants: [
          { name: 'Comfort 1.5T', yearStart: 2023, yearEnd: 2026 },
          { name: 'Luxury 1.5T', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'CS55 Plus',
        variants: [
          { name: '1.5T DCT', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Hunter',
        variants: [
          { name: 'Pickup 1.9 Diesel MT', yearStart: 2023, yearEnd: 2026 },
          { name: 'Pickup 1.9 Diesel AT', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Karvaan',
        variants: [
          { name: 'Standard 1.0', yearStart: 2021, yearEnd: 2026 },
          { name: 'Plus 1.0', yearStart: 2021, yearEnd: 2026 },
          { name: 'Bold 1.2', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'M9',
        variants: [
          { name: 'Pickup 1.0', yearStart: 2022, yearEnd: 2026 },
          { name: 'Pickup 1.2', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Deepal L07',
        variants: [
          { name: 'EV', yearStart: 2024, yearEnd: 2026 },
          { name: 'EREV', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Deepal S07',
        variants: [
          { name: 'EV', yearStart: 2024, yearEnd: 2026 },
          { name: 'EREV', yearStart: 2024, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ HAVAL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Haval',
    logo: `${LOGO_BASE}/haval-logo.png`,
    models: [
      {
        name: 'H6',
        variants: [
          { name: '1.5T 2WD', yearStart: 2022, yearEnd: 2026 },
          { name: '2.0T AWD', yearStart: 2022, yearEnd: 2026 },
          { name: 'HEV 1.5T', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Jolion',
        variants: [
          { name: '1.5T DCT', yearStart: 2023, yearEnd: 2026 },
          { name: 'HEV 1.5T', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'H6 GT',
        variants: [{ name: '2.0T AWD', yearStart: 2024, yearEnd: 2026 }],
      },
      {
        name: 'Dargo',
        variants: [
          { name: '2.0T 2WD', yearStart: 2024, yearEnd: 2026 },
          { name: '2.0T AWD', yearStart: 2024, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ PROTON â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Proton',
    logo: `${LOGO_BASE}/proton-logo.png`,
    models: [
      {
        name: 'Saga',
        variants: [
          { name: 'Standard MT 1.3', yearStart: 2021, yearEnd: 2026 },
          { name: 'Standard AT 1.3', yearStart: 2021, yearEnd: 2026 },
          { name: 'Ace AT 1.3', yearStart: 2021, yearEnd: 2026 },
          { name: 'R3 1.3', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'X70',
        variants: [
          { name: 'Executive 1.5T', yearStart: 2020, yearEnd: 2026 },
          { name: 'Premium 1.5T', yearStart: 2020, yearEnd: 2026 },
          { name: 'Premium X FL 1.5T', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'X50',
        variants: [
          { name: 'Standard 1.5', yearStart: 2024, yearEnd: 2026 },
          { name: 'Executive 1.5T', yearStart: 2024, yearEnd: 2026 },
          { name: 'Flagship 1.5T', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'X90',
        variants: [
          { name: '1.5T 2WD', yearStart: 2025, yearEnd: 2026 },
          { name: '1.5T AWD', yearStart: 2025, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ FAW â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'FAW',
    logo: `${LOGO_BASE}/faw-logo.png`,
    models: [
      {
        name: 'V2',
        variants: [
          { name: 'VCT-i 1.3 MT', yearStart: 2015, yearEnd: 2023 },
          { name: 'VCT-i 1.3 AT', yearStart: 2017, yearEnd: 2023 },
        ],
      },
      {
        name: 'X-PV',
        variants: [
          { name: 'Standard 1.0', yearStart: 2015, yearEnd: 2025 },
          { name: 'Dual AC 1.0', yearStart: 2017, yearEnd: 2025 },
          { name: 'Power Edition 1.2', yearStart: 2022, yearEnd: 2025 },
        ],
      },
      {
        name: 'Carrier',
        variants: [
          { name: 'Standard 1.0', yearStart: 2015, yearEnd: 2025 },
          { name: 'Flatbed 1.0', yearStart: 2015, yearEnd: 2025 },
          { name: 'DL 1.2', yearStart: 2022, yearEnd: 2025 },
        ],
      },
      {
        name: 'XPV Loader',
        variants: [
          { name: '1.0', yearStart: 2016, yearEnd: 2023 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ DFSK / PRINCE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'DFSK',
    logo: `${LOGO_BASE}/dfsk-logo.png`,
    models: [
      {
        name: 'Prince K01',
        variants: [
          { name: 'Loader 800', yearStart: 2019, yearEnd: 2026 },
        ],
      },
      {
        name: 'Prince K07',
        variants: [
          { name: 'Standard 1.0', yearStart: 2019, yearEnd: 2026 },
          { name: 'Plus 1.0', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'Prince Pearl',
        variants: [
          { name: 'Standard 800', yearStart: 2019, yearEnd: 2024 },
          { name: 'REX 7 800', yearStart: 2020, yearEnd: 2024 },
        ],
      },
      {
        name: 'Glory 580',
        variants: [
          { name: 'Comfort 1.5T', yearStart: 2019, yearEnd: 2024 },
          { name: 'Pro 1.5T', yearStart: 2019, yearEnd: 2024 },
        ],
      },
      {
        name: 'Glory 580 Pro',
        variants: [
          { name: '1.5T CVT', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'Glory 500',
        variants: [{ name: '1.5 MT', yearStart: 2019, yearEnd: 2023 }],
      },
      {
        name: 'Honor Plus',
        variants: [
          { name: 'Pickup 1.5', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'C37',
        variants: [
          { name: '1.5 Van', yearStart: 2020, yearEnd: 2025 },
        ],
      },
      {
        name: 'C31',
        variants: [
          { name: '1.5 Pickup', yearStart: 2020, yearEnd: 2025 },
        ],
      },
      {
        name: 'Seres 3',
        variants: [
          { name: 'EV Standard Range', yearStart: 2024, yearEnd: 2026 },
          { name: 'EV Long Range', yearStart: 2024, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ UNITED â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'United',
    logo: '',
    models: [
      {
        name: 'Bravo',
        variants: [
          { name: 'Standard 800', yearStart: 2019, yearEnd: 2026 },
          { name: 'VXL 800', yearStart: 2019, yearEnd: 2026 },
        ],
      },
      {
        name: 'Alpha',
        variants: [
          { name: 'Standard 1000', yearStart: 2020, yearEnd: 2026 },
          { name: 'Plus 1000', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'Auto Rickshaw',
        variants: [
          { name: 'CNG 200cc', yearStart: 2015, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ CHERY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Chery',
    logo: `${LOGO_BASE}/chery-logo.png`,
    models: [
      {
        name: 'Tiggo 4 Pro',
        variants: [
          { name: 'Comfort 1.5', yearStart: 2024, yearEnd: 2026 },
          { name: 'Luxury 1.5', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Tiggo 7 Pro',
        variants: [
          { name: '1.5T CVT', yearStart: 2024, yearEnd: 2026 },
          { name: '1.6T DCT', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Tiggo 8 Pro',
        variants: [
          { name: 'Luxury 1.6T', yearStart: 2024, yearEnd: 2026 },
          { name: 'Premium 2.0T', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Arrizo 5',
        variants: [
          { name: '1.5T CVT', yearStart: 2024, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ BAIC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'BAIC',
    logo: `${LOGO_BASE}/baic-logo.png`,
    models: [
      {
        name: 'D20',
        variants: [
          { name: 'Hatchback 1.3', yearStart: 2023, yearEnd: 2026 },
          { name: 'Hatchback 1.5', yearStart: 2023, yearEnd: 2026 },
          { name: 'Sedan 1.5', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'BJ40',
        variants: [
          { name: 'Plus 2.0T', yearStart: 2023, yearEnd: 2026 },
          { name: 'Plus City Hunter 2.0T', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'X55',
        variants: [
          { name: 'Elite 1.5T', yearStart: 2024, yearEnd: 2026 },
          { name: 'Pro 1.5T', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'X7',
        variants: [
          { name: '1.5T', yearStart: 2024, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ JAC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'JAC',
    logo: `${LOGO_BASE}/jac-logo.png`,
    models: [
      {
        name: 'X200',
        variants: [
          { name: 'Pickup 2.8 Diesel', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'T6',
        variants: [
          { name: '2.0 Petrol', yearStart: 2022, yearEnd: 2026 },
          { name: '2.0 Diesel', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'T8',
        variants: [
          { name: '2.0T Diesel 4x2', yearStart: 2023, yearEnd: 2026 },
          { name: '2.0T Diesel 4x4', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'T9',
        variants: [
          { name: '2.0T Diesel 4x2', yearStart: 2024, yearEnd: 2026 },
          { name: '2.0T Diesel 4x4', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'JS4',
        variants: [
          { name: '1.5 CVT', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'JS6',
        variants: [
          { name: '1.5T DCT', yearStart: 2024, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ ISUZU â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Isuzu',
    logo: `${LOGO_BASE}/isuzu-logo.png`,
    models: [
      {
        name: 'D-Max',
        variants: [
          { name: 'Hi-Lander 1.9D AT', yearStart: 2020, yearEnd: 2026 },
          { name: 'V-Cross 3.0D AT 4x4', yearStart: 2020, yearEnd: 2026 },
          { name: 'Single Cab 1.9D', yearStart: 2020, yearEnd: 2026 },
          { name: 'Hi-Lander 3.0D AT', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'MU-X',
        variants: [
          { name: '1.9D AT 4x2', yearStart: 2022, yearEnd: 2026 },
          { name: '3.0D AT 4x4', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'NLR',
        variants: [
          { name: 'Truck 3.0 Diesel', yearStart: 2018, yearEnd: 2026 },
        ],
      },
      {
        name: 'NPR',
        variants: [
          { name: 'Truck 5.2 Diesel', yearStart: 2018, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ PEUGEOT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Peugeot',
    logo: `${LOGO_BASE}/peugeot-logo.png`,
    models: [
      {
        name: '2008',
        variants: [
          { name: 'Active 1.2T', yearStart: 2023, yearEnd: 2026 },
          { name: 'Allure 1.2T', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: '3008',
        variants: [
          { name: 'Active 1.6T', yearStart: 2024, yearEnd: 2026 },
          { name: 'Allure 1.6T', yearStart: 2024, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ BYD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'BYD',
    logo: `${LOGO_BASE}/byd-logo.png`,
    models: [
      {
        name: 'Atto 3',
        variants: [
          { name: 'Standard Range EV', yearStart: 2024, yearEnd: 2026 },
          { name: 'Extended Range EV', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Dolphin',
        variants: [
          { name: 'Standard EV', yearStart: 2024, yearEnd: 2026 },
          { name: 'Extended Range EV', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Seal',
        variants: [
          { name: 'Dynamic EV RWD', yearStart: 2024, yearEnd: 2026 },
          { name: 'Premium EV AWD', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Seal U',
        variants: [
          { name: 'DM-i Comfort PHEV', yearStart: 2024, yearEnd: 2026 },
          { name: 'DM-i Premium PHEV', yearStart: 2024, yearEnd: 2026 },
          { name: 'EV', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Han',
        variants: [
          { name: 'EV Premium', yearStart: 2024, yearEnd: 2026 },
          { name: 'DM-i PHEV', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Tang',
        variants: [
          { name: 'DM-i PHEV AWD', yearStart: 2024, yearEnd: 2026 },
          { name: 'EV AWD', yearStart: 2024, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ SAZGAR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Sazgar',
    logo: '',
    models: [
      {
        name: 'BAIC BJ40',
        variants: [
          { name: 'Plus 2.0T (Assembled)', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Auto Rickshaw',
        variants: [
          { name: '4-Stroke CNG 200cc', yearStart: 2010, yearEnd: 2026 },
          { name: 'Electric', yearStart: 2022, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ MASTER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Master',
    logo: '',
    models: [
      {
        name: 'Molten',
        variants: [
          { name: '1.0 Hatchback', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Changan M9 (Assembled)',
        variants: [
          { name: '1.0 Pickup', yearStart: 2020, yearEnd: 2025 },
        ],
      },
      {
        name: 'Loader Truck',
        variants: [
          { name: '1.0 Standard', yearStart: 2015, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ ROAD PRINCE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Road Prince',
    logo: '',
    models: [
      {
        name: 'Pickup',
        variants: [
          { name: '800cc', yearStart: 2018, yearEnd: 2026 },
          { name: '1000cc', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'Loader',
        variants: [
          { name: '150cc', yearStart: 2015, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ HINO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Hino',
    logo: `${LOGO_BASE}/hino-logo.png`,
    models: [
      {
        name: '300 Series',
        variants: [
          { name: '616 4.0 Diesel', yearStart: 2015, yearEnd: 2026 },
          { name: '716 4.0 Diesel', yearStart: 2015, yearEnd: 2026 },
          { name: '816 4.0 Diesel', yearStart: 2015, yearEnd: 2026 },
        ],
      },
      {
        name: '500 Series',
        variants: [
          { name: 'FD 7.7 Diesel', yearStart: 2015, yearEnd: 2026 },
          { name: 'FG 7.7 Diesel', yearStart: 2015, yearEnd: 2026 },
          { name: 'FM 7.7 Diesel', yearStart: 2015, yearEnd: 2026 },
        ],
      },
      {
        name: 'AK Bus',
        variants: [
          { name: '500R', yearStart: 2018, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // POPULAR JDM / GREY-MARKET IMPORTS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ NISSAN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Nissan',
    logo: `${LOGO_BASE}/nissan-logo.png`,
    models: [
      {
        name: 'Dayz',
        variants: [
          { name: 'J 660', yearStart: 2015, yearEnd: 2023 },
          { name: 'X 660', yearStart: 2015, yearEnd: 2023 },
          { name: 'Highway Star 660', yearStart: 2015, yearEnd: 2023 },
          { name: 'Highway Star G Turbo 660', yearStart: 2019, yearEnd: 2023 },
        ],
      },
      {
        name: 'Roox',
        variants: [
          { name: 'S 660', yearStart: 2018, yearEnd: 2023 },
          { name: 'Highway Star 660', yearStart: 2018, yearEnd: 2023 },
          { name: 'Highway Star G Turbo 660', yearStart: 2020, yearEnd: 2023 },
        ],
      },
      {
        name: 'Moco',
        variants: [
          { name: 'S 660', yearStart: 2015, yearEnd: 2020 },
          { name: 'X 660', yearStart: 2015, yearEnd: 2020 },
        ],
      },
      {
        name: 'Clipper',
        variants: [
          { name: 'DX 660', yearStart: 2015, yearEnd: 2022 },
          { name: 'Rio 660', yearStart: 2015, yearEnd: 2022 },
        ],
      },
      {
        name: 'Note',
        variants: [
          { name: 'X 1.2', yearStart: 2016, yearEnd: 2023 },
          { name: 'Medalist 1.2', yearStart: 2016, yearEnd: 2023 },
          { name: 'e-Power X 1.2', yearStart: 2017, yearEnd: 2023 },
          { name: 'e-Power Medalist 1.2', yearStart: 2017, yearEnd: 2023 },
          { name: 'Aura e-Power (3rd Gen)', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'Sunny',
        variants: [
          { name: 'EX Saloon 1.3', yearStart: 2012, yearEnd: 2018 },
          { name: 'Super Saloon 1.6', yearStart: 2012, yearEnd: 2018 },
        ],
      },
      {
        name: 'Juke',
        variants: [
          { name: '15RX 1.5', yearStart: 2015, yearEnd: 2020 },
          { name: '16GT 1.6 Turbo', yearStart: 2015, yearEnd: 2020 },
        ],
      },
      {
        name: 'Kicks',
        variants: [
          { name: 'X 1.2 e-Power', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'X-Trail',
        variants: [
          { name: '20X 2.0', yearStart: 2016, yearEnd: 2023 },
          { name: '20Xi 2.0', yearStart: 2018, yearEnd: 2023 },
          { name: 'Hybrid 2.0', yearStart: 2017, yearEnd: 2023 },
          { name: 'e-Power (4th Gen)', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Serena',
        variants: [
          { name: 'Highway Star 2.0', yearStart: 2016, yearEnd: 2023 },
          { name: 'e-Power Highway Star 1.2', yearStart: 2018, yearEnd: 2023 },
        ],
      },
      {
        name: 'Navara',
        variants: [
          { name: 'SE 2.5 Diesel', yearStart: 2018, yearEnd: 2024 },
          { name: 'LE 2.5 Diesel', yearStart: 2018, yearEnd: 2024 },
          { name: 'PRO-4X 2.5 Diesel', yearStart: 2021, yearEnd: 2024 },
        ],
      },
      {
        name: 'Patrol',
        variants: [
          { name: 'Y62 5.6 V8', yearStart: 2018, yearEnd: 2026 },
          { name: 'Y62 4.0 V6', yearStart: 2018, yearEnd: 2026 },
          { name: 'Y62 Nismo 5.6 V8', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'Leaf',
        variants: [
          { name: 'S EV 40kWh', yearStart: 2018, yearEnd: 2023 },
          { name: 'e+ EV 62kWh', yearStart: 2019, yearEnd: 2023 },
        ],
      },
      {
        name: 'GT-R',
        variants: [
          { name: 'Premium Edition 3.8T', yearStart: 2017, yearEnd: 2024 },
          { name: 'Nismo 3.8T', yearStart: 2020, yearEnd: 2024 },
        ],
      },
      {
        name: 'Z (Fairlady)',
        variants: [
          { name: 'Performance 3.0T', yearStart: 2023, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ MITSUBISHI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Mitsubishi',
    logo: `${LOGO_BASE}/mitsubishi-logo.png`,
    models: [
      {
        name: 'Mirage',
        variants: [
          { name: 'GLS 1.2', yearStart: 2015, yearEnd: 2023 },
          { name: 'G4 GLS 1.2 Sedan', yearStart: 2015, yearEnd: 2023 },
        ],
      },
      {
        name: 'Lancer',
        variants: [
          { name: 'GLX 1.3', yearStart: 2010, yearEnd: 2017 },
          { name: 'GLX 1.5', yearStart: 2010, yearEnd: 2017 },
          { name: 'GLX 1.6', yearStart: 2010, yearEnd: 2017 },
        ],
      },
      {
        name: 'Lancer Evolution',
        variants: [
          { name: 'Evo X GSR 2.0T', yearStart: 2008, yearEnd: 2016 },
          { name: 'Evo X MR 2.0T', yearStart: 2008, yearEnd: 2016 },
        ],
      },
      {
        name: 'Outlander',
        variants: [
          { name: 'Sport 2.0', yearStart: 2015, yearEnd: 2023 },
          { name: 'PHEV 2.4', yearStart: 2018, yearEnd: 2023 },
          { name: '2.5 (4th Gen)', yearStart: 2022, yearEnd: 2026 },
          { name: 'PHEV (4th Gen)', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Pajero',
        variants: [
          { name: 'GLS 3.0 V6', yearStart: 2015, yearEnd: 2021 },
          { name: 'Exceed 3.2 Diesel', yearStart: 2015, yearEnd: 2021 },
          { name: 'GLS 3.8 V6', yearStart: 2015, yearEnd: 2021 },
        ],
      },
      {
        name: 'Pajero Sport / Montero Sport',
        variants: [
          { name: '2.4 Diesel', yearStart: 2016, yearEnd: 2024 },
          { name: '3.0 V6', yearStart: 2016, yearEnd: 2024 },
        ],
      },
      {
        name: 'Eclipse Cross',
        variants: [
          { name: '1.5T', yearStart: 2019, yearEnd: 2024 },
          { name: 'PHEV 2.4', yearStart: 2021, yearEnd: 2024 },
        ],
      },
      {
        name: 'L200 Triton',
        variants: [
          { name: 'GLX 2.4 Diesel', yearStart: 2018, yearEnd: 2024 },
          { name: 'Athlete 2.4 Diesel', yearStart: 2020, yearEnd: 2024 },
        ],
      },
      {
        name: 'Xpander',
        variants: [
          { name: 'GLX 1.5', yearStart: 2020, yearEnd: 2026 },
          { name: 'GLS 1.5', yearStart: 2020, yearEnd: 2026 },
          { name: 'Cross 1.5', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'eK X',
        variants: [
          { name: '660', yearStart: 2019, yearEnd: 2023 },
          { name: 'T 660 Turbo', yearStart: 2019, yearEnd: 2023 },
        ],
      },
      {
        name: 'eK Wagon',
        variants: [
          { name: 'G 660', yearStart: 2019, yearEnd: 2023 },
          { name: 'M 660', yearStart: 2019, yearEnd: 2023 },
        ],
      },
      {
        name: 'Delica D:5',
        variants: [
          { name: 'G 2.2 Diesel', yearStart: 2019, yearEnd: 2024 },
          { name: 'P 2.2 Diesel', yearStart: 2019, yearEnd: 2024 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ DAIHATSU â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Daihatsu',
    logo: `${LOGO_BASE}/daihatsu-logo.png`,
    models: [
      {
        name: 'Mira',
        variants: [
          { name: 'X 660', yearStart: 2015, yearEnd: 2023 },
          { name: 'L SA 660', yearStart: 2015, yearEnd: 2023 },
          { name: 'X Special 660', yearStart: 2018, yearEnd: 2023 },
        ],
      },
      {
        name: 'Mira e:S',
        variants: [
          { name: 'L 660', yearStart: 2017, yearEnd: 2023 },
          { name: 'X 660', yearStart: 2017, yearEnd: 2023 },
          { name: 'G SA III 660', yearStart: 2017, yearEnd: 2023 },
        ],
      },
      {
        name: 'Move',
        variants: [
          { name: 'X 660', yearStart: 2015, yearEnd: 2023 },
          { name: 'L 660', yearStart: 2015, yearEnd: 2023 },
          { name: 'Custom X 660', yearStart: 2015, yearEnd: 2023 },
          { name: 'Custom RS 660 Turbo', yearStart: 2015, yearEnd: 2023 },
          { name: 'Canbus X 660', yearStart: 2016, yearEnd: 2023 },
        ],
      },
      {
        name: 'Tanto',
        variants: [
          { name: 'X 660', yearStart: 2015, yearEnd: 2023 },
          { name: 'L 660', yearStart: 2015, yearEnd: 2023 },
          { name: 'Custom X 660', yearStart: 2015, yearEnd: 2023 },
          { name: 'Custom RS 660 Turbo', yearStart: 2015, yearEnd: 2023 },
          { name: 'Fun Cross 660', yearStart: 2020, yearEnd: 2023 },
        ],
      },
      {
        name: 'Hijet',
        variants: [
          { name: 'Cargo 660', yearStart: 2015, yearEnd: 2023 },
          { name: 'Caddie 660', yearStart: 2016, yearEnd: 2023 },
          { name: 'Truck 660', yearStart: 2015, yearEnd: 2023 },
        ],
      },
      {
        name: 'Wake',
        variants: [
          { name: 'G SA 660', yearStart: 2016, yearEnd: 2022 },
          { name: 'G Turbo SA 660', yearStart: 2016, yearEnd: 2022 },
        ],
      },
      {
        name: 'Cast',
        variants: [
          { name: 'Activa G 660', yearStart: 2015, yearEnd: 2022 },
          { name: 'Style G 660', yearStart: 2015, yearEnd: 2022 },
          { name: 'Sport 660 Turbo', yearStart: 2016, yearEnd: 2022 },
        ],
      },
      {
        name: 'Copen',
        variants: [
          { name: 'Cero 660 Turbo', yearStart: 2015, yearEnd: 2023 },
          { name: 'Robe 660 Turbo', yearStart: 2015, yearEnd: 2023 },
          { name: 'GR Sport 660 Turbo', yearStart: 2019, yearEnd: 2023 },
        ],
      },
      {
        name: 'Taft',
        variants: [
          { name: 'G 660', yearStart: 2020, yearEnd: 2023 },
          { name: 'G Turbo 660', yearStart: 2020, yearEnd: 2023 },
        ],
      },
      {
        name: 'Rocky',
        variants: [
          { name: 'Premium G 1.0 Turbo', yearStart: 2020, yearEnd: 2023 },
          { name: 'Hybrid 1.2', yearStart: 2022, yearEnd: 2023 },
        ],
      },
      {
        name: 'Boon',
        variants: [
          { name: 'Cilq 1.0', yearStart: 2016, yearEnd: 2023 },
          { name: 'X SA III 1.0', yearStart: 2016, yearEnd: 2023 },
        ],
      },
      {
        name: 'Thor',
        variants: [
          { name: 'X 1.0', yearStart: 2016, yearEnd: 2023 },
          { name: 'Custom G Turbo 1.0', yearStart: 2016, yearEnd: 2023 },
        ],
      },
      {
        name: 'Atrai',
        variants: [
          { name: 'X 660', yearStart: 2015, yearEnd: 2023 },
          { name: 'RS 660 Turbo', yearStart: 2022, yearEnd: 2023 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ MAZDA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Mazda',
    logo: `${LOGO_BASE}/mazda-logo.png`,
    models: [
      {
        name: 'Demio / Mazda 2',
        variants: [
          { name: '13S 1.3', yearStart: 2015, yearEnd: 2023 },
          { name: '15S 1.5', yearStart: 2015, yearEnd: 2023 },
          { name: 'XD 1.5 Diesel', yearStart: 2015, yearEnd: 2023 },
        ],
      },
      {
        name: 'Mazda 3',
        variants: [
          { name: '20S 2.0', yearStart: 2019, yearEnd: 2026 },
          { name: 'X 1.8 Diesel', yearStart: 2019, yearEnd: 2026 },
          { name: '20S Touring 2.0', yearStart: 2015, yearEnd: 2019 },
        ],
      },
      {
        name: 'Mazda 6 / Atenza',
        variants: [
          { name: '20S 2.0', yearStart: 2015, yearEnd: 2022 },
          { name: '25S L Package 2.5', yearStart: 2015, yearEnd: 2022 },
          { name: 'XD 2.2 Diesel', yearStart: 2015, yearEnd: 2022 },
        ],
      },
      {
        name: 'CX-3',
        variants: [
          { name: '20S 2.0', yearStart: 2015, yearEnd: 2023 },
          { name: 'XD 1.8 Diesel', yearStart: 2015, yearEnd: 2023 },
        ],
      },
      {
        name: 'CX-30',
        variants: [
          { name: '20S 2.0', yearStart: 2020, yearEnd: 2026 },
          { name: 'XD 1.8 Diesel', yearStart: 2020, yearEnd: 2026 },
          { name: 'e-Skyactiv X 2.0', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'CX-5',
        variants: [
          { name: '20S 2.0', yearStart: 2017, yearEnd: 2026 },
          { name: '25S 2.5', yearStart: 2017, yearEnd: 2026 },
          { name: 'XD 2.2 Diesel', yearStart: 2017, yearEnd: 2026 },
          { name: '25T 2.5 Turbo', yearStart: 2019, yearEnd: 2026 },
        ],
      },
      {
        name: 'CX-8',
        variants: [
          { name: 'XD 2.2 Diesel', yearStart: 2018, yearEnd: 2024 },
          { name: '25S 2.5', yearStart: 2018, yearEnd: 2024 },
          { name: '25T 2.5 Turbo', yearStart: 2019, yearEnd: 2024 },
        ],
      },
      {
        name: 'CX-60',
        variants: [
          { name: '25S S Package 2.5', yearStart: 2022, yearEnd: 2026 },
          { name: 'XD-Hybrid 3.3 Diesel', yearStart: 2022, yearEnd: 2026 },
          { name: 'PHEV 2.5', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'Flair',
        variants: [
          { name: 'Hybrid XG 660', yearStart: 2017, yearEnd: 2023 },
          { name: 'Custom Style XS 660', yearStart: 2017, yearEnd: 2023 },
        ],
      },
      {
        name: 'Flair Crossover',
        variants: [
          { name: 'XG 660', yearStart: 2017, yearEnd: 2023 },
          { name: 'XT 660 Turbo', yearStart: 2017, yearEnd: 2023 },
        ],
      },
      {
        name: 'Scrum',
        variants: [
          { name: 'PA 660 Van', yearStart: 2015, yearEnd: 2023 },
          { name: 'Wagon PZ Turbo 660', yearStart: 2015, yearEnd: 2023 },
        ],
      },
      {
        name: 'MX-5 / Roadster',
        variants: [
          { name: 'S 1.5', yearStart: 2015, yearEnd: 2026 },
          { name: 'RS 1.5', yearStart: 2015, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ SUBARU â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Subaru',
    logo: `${LOGO_BASE}/subaru-logo.png`,
    models: [
      {
        name: 'Forester',
        variants: [
          { name: '2.0 X-Break', yearStart: 2018, yearEnd: 2026 },
          { name: '2.0 Advance', yearStart: 2018, yearEnd: 2026 },
          { name: '2.0 Premium', yearStart: 2018, yearEnd: 2026 },
          { name: 'e-Boxer Hybrid', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'XV / Crosstrek',
        variants: [
          { name: '1.6i-L', yearStart: 2017, yearEnd: 2023 },
          { name: '2.0e-L Advance', yearStart: 2017, yearEnd: 2023 },
          { name: '2.0 e-Boxer Hybrid', yearStart: 2019, yearEnd: 2023 },
        ],
      },
      {
        name: 'Impreza',
        variants: [
          { name: '1.6i-L', yearStart: 2017, yearEnd: 2023 },
          { name: '2.0i-S', yearStart: 2017, yearEnd: 2023 },
        ],
      },
      {
        name: 'WRX',
        variants: [
          { name: 'STI 2.5 Turbo', yearStart: 2015, yearEnd: 2021 },
          { name: '2.4 Turbo (VB)', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'BRZ',
        variants: [
          { name: 'S 2.0', yearStart: 2017, yearEnd: 2021 },
          { name: 'S 2.4 (2nd Gen)', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'Outback',
        variants: [
          { name: 'X-Break 1.8 Turbo', yearStart: 2021, yearEnd: 2026 },
          { name: 'Limited 1.8 Turbo', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'Levorg',
        variants: [
          { name: '1.6 GT', yearStart: 2015, yearEnd: 2020 },
          { name: '1.8 GT-H', yearStart: 2020, yearEnd: 2026 },
          { name: '1.8 STI Sport', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'Legacy',
        variants: [
          { name: 'B4 2.5', yearStart: 2015, yearEnd: 2020 },
        ],
      },
    ],
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // LUXURY / PREMIUM BRANDS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ BMW â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'BMW',
    logo: `${LOGO_BASE}/bmw-logo.png`,
    models: [
      {
        name: '2 Series',
        variants: [
          { name: '218i Gran Coupe', yearStart: 2020, yearEnd: 2026 },
          { name: '220i', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: '3 Series',
        variants: [
          { name: '318i', yearStart: 2018, yearEnd: 2026 },
          { name: '320i', yearStart: 2018, yearEnd: 2026 },
          { name: '320d', yearStart: 2018, yearEnd: 2026 },
          { name: '330i', yearStart: 2018, yearEnd: 2026 },
          { name: '330i M Sport', yearStart: 2019, yearEnd: 2026 },
          { name: '330e PHEV', yearStart: 2020, yearEnd: 2026 },
          { name: 'M3 Competition 3.0T', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: '4 Series',
        variants: [
          { name: '420i Gran Coupe', yearStart: 2021, yearEnd: 2026 },
          { name: 'M4 Competition 3.0T', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: '5 Series',
        variants: [
          { name: '520i', yearStart: 2018, yearEnd: 2026 },
          { name: '520d', yearStart: 2018, yearEnd: 2026 },
          { name: '530i', yearStart: 2018, yearEnd: 2026 },
          { name: '530e PHEV', yearStart: 2020, yearEnd: 2026 },
          { name: '540i', yearStart: 2018, yearEnd: 2024 },
          { name: 'M5 Competition 4.4T', yearStart: 2019, yearEnd: 2024 },
        ],
      },
      {
        name: '7 Series',
        variants: [
          { name: '740Li', yearStart: 2018, yearEnd: 2026 },
          { name: '740d', yearStart: 2018, yearEnd: 2024 },
          { name: '760i xDrive', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: '8 Series',
        variants: [
          { name: '840i Gran Coupe', yearStart: 2020, yearEnd: 2026 },
          { name: 'M8 Competition', yearStart: 2020, yearEnd: 2024 },
        ],
      },
      {
        name: 'X1',
        variants: [
          { name: 'sDrive18i', yearStart: 2018, yearEnd: 2026 },
          { name: 'sDrive20i', yearStart: 2018, yearEnd: 2026 },
        ],
      },
      {
        name: 'X3',
        variants: [
          { name: 'xDrive20i', yearStart: 2018, yearEnd: 2026 },
          { name: 'xDrive30i', yearStart: 2018, yearEnd: 2026 },
          { name: 'M40i', yearStart: 2019, yearEnd: 2026 },
        ],
      },
      {
        name: 'X5',
        variants: [
          { name: 'xDrive40i', yearStart: 2018, yearEnd: 2026 },
          { name: 'xDrive45e PHEV', yearStart: 2020, yearEnd: 2026 },
          { name: 'M50i', yearStart: 2020, yearEnd: 2026 },
          { name: 'X5 M Competition', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'X6',
        variants: [
          { name: 'xDrive40i', yearStart: 2020, yearEnd: 2026 },
          { name: 'M50i', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'X7',
        variants: [
          { name: 'xDrive40i', yearStart: 2020, yearEnd: 2026 },
          { name: 'M60i', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Z4',
        variants: [
          { name: 'sDrive30i', yearStart: 2019, yearEnd: 2026 },
          { name: 'M40i', yearStart: 2019, yearEnd: 2026 },
        ],
      },
      {
        name: 'i4',
        variants: [
          { name: 'eDrive40', yearStart: 2023, yearEnd: 2026 },
          { name: 'M50', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'iX',
        variants: [
          { name: 'xDrive40', yearStart: 2023, yearEnd: 2026 },
          { name: 'xDrive50', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'iX3',
        variants: [{ name: 'Inspiring', yearStart: 2022, yearEnd: 2026 }],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ MERCEDES-BENZ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Mercedes-Benz',
    logo: `${LOGO_BASE}/mercedes-benz-logo.png`,
    models: [
      {
        name: 'A-Class',
        variants: [
          { name: 'A200', yearStart: 2019, yearEnd: 2026 },
          { name: 'A250', yearStart: 2019, yearEnd: 2026 },
          { name: 'AMG A35', yearStart: 2019, yearEnd: 2026 },
          { name: 'A180d', yearStart: 2019, yearEnd: 2024 },
        ],
      },
      {
        name: 'C-Class',
        variants: [
          { name: 'C180', yearStart: 2018, yearEnd: 2026 },
          { name: 'C200', yearStart: 2018, yearEnd: 2026 },
          { name: 'C200 4MATIC', yearStart: 2022, yearEnd: 2026 },
          { name: 'C300', yearStart: 2018, yearEnd: 2026 },
          { name: 'C300d', yearStart: 2022, yearEnd: 2026 },
          { name: 'AMG C43 4MATIC', yearStart: 2019, yearEnd: 2026 },
          { name: 'AMG C63 S', yearStart: 2019, yearEnd: 2024 },
        ],
      },
      {
        name: 'E-Class',
        variants: [
          { name: 'E200', yearStart: 2018, yearEnd: 2026 },
          { name: 'E300', yearStart: 2018, yearEnd: 2026 },
          { name: 'E350', yearStart: 2018, yearEnd: 2026 },
          { name: 'E450 4MATIC', yearStart: 2022, yearEnd: 2026 },
          { name: 'AMG E53 4MATIC+', yearStart: 2019, yearEnd: 2026 },
          { name: 'AMG E63 S', yearStart: 2019, yearEnd: 2024 },
        ],
      },
      {
        name: 'S-Class',
        variants: [
          { name: 'S400d', yearStart: 2018, yearEnd: 2026 },
          { name: 'S450', yearStart: 2018, yearEnd: 2026 },
          { name: 'S500', yearStart: 2018, yearEnd: 2026 },
          { name: 'S580', yearStart: 2021, yearEnd: 2026 },
          { name: 'Maybach S580', yearStart: 2021, yearEnd: 2026 },
          { name: 'AMG S63', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'CLA',
        variants: [
          { name: 'CLA200', yearStart: 2019, yearEnd: 2026 },
          { name: 'CLA250', yearStart: 2019, yearEnd: 2026 },
          { name: 'AMG CLA35', yearStart: 2019, yearEnd: 2026 },
          { name: 'AMG CLA45 S', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'GLA',
        variants: [
          { name: 'GLA200', yearStart: 2019, yearEnd: 2026 },
          { name: 'GLA250', yearStart: 2019, yearEnd: 2026 },
          { name: 'AMG GLA35', yearStart: 2021, yearEnd: 2026 },
          { name: 'AMG GLA45 S', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'GLB',
        variants: [
          { name: 'GLB200', yearStart: 2020, yearEnd: 2026 },
          { name: 'GLB250', yearStart: 2020, yearEnd: 2026 },
          { name: 'AMG GLB35', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'GLC',
        variants: [
          { name: 'GLC200', yearStart: 2018, yearEnd: 2026 },
          { name: 'GLC300', yearStart: 2018, yearEnd: 2026 },
          { name: 'GLC300 4MATIC', yearStart: 2022, yearEnd: 2026 },
          { name: 'AMG GLC43', yearStart: 2018, yearEnd: 2026 },
          { name: 'AMG GLC63 S', yearStart: 2019, yearEnd: 2024 },
          { name: 'GLC Coupe 300', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'GLE',
        variants: [
          { name: 'GLE350', yearStart: 2019, yearEnd: 2026 },
          { name: 'GLE450', yearStart: 2019, yearEnd: 2026 },
          { name: 'GLE580', yearStart: 2020, yearEnd: 2026 },
          { name: 'AMG GLE53 4MATIC+', yearStart: 2020, yearEnd: 2026 },
          { name: 'AMG GLE63 S', yearStart: 2020, yearEnd: 2026 },
          { name: 'GLE Coupe 450', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'GLS',
        variants: [
          { name: 'GLS450', yearStart: 2020, yearEnd: 2026 },
          { name: 'GLS580', yearStart: 2020, yearEnd: 2026 },
          { name: 'Maybach GLS600', yearStart: 2021, yearEnd: 2026 },
          { name: 'AMG GLS63', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'G-Class',
        variants: [
          { name: 'G500', yearStart: 2019, yearEnd: 2026 },
          { name: 'G63 AMG', yearStart: 2019, yearEnd: 2026 },
          { name: 'G65 AMG', yearStart: 2015, yearEnd: 2019 },
        ],
      },
      {
        name: 'V-Class',
        variants: [
          { name: 'V250d', yearStart: 2019, yearEnd: 2026 },
          { name: 'V300d', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'EQE',
        variants: [
          { name: '350+', yearStart: 2023, yearEnd: 2026 },
          { name: 'AMG EQE 53', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'EQS',
        variants: [
          { name: '450+', yearStart: 2023, yearEnd: 2026 },
          { name: '580 4MATIC', yearStart: 2023, yearEnd: 2026 },
          { name: 'Maybach EQS 680 SUV', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'EQB',
        variants: [
          { name: 'EQB250+', yearStart: 2023, yearEnd: 2026 },
          { name: 'EQB350 4MATIC', yearStart: 2023, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ AUDI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Audi',
    logo: `${LOGO_BASE}/audi-logo.png`,
    models: [
      { name: 'A3', variants: [
        { name: '30 TFSI', yearStart: 2018, yearEnd: 2026 },
        { name: '35 TFSI', yearStart: 2018, yearEnd: 2026 },
        { name: 'S3 2.0T', yearStart: 2020, yearEnd: 2026 },
      ]},
      {
        name: 'A4',
        variants: [
          { name: '35 TFSI', yearStart: 2018, yearEnd: 2026 },
          { name: '40 TFSI', yearStart: 2018, yearEnd: 2026 },
          { name: '45 TFSI Quattro', yearStart: 2018, yearEnd: 2026 },
          { name: 'S4 3.0T', yearStart: 2019, yearEnd: 2026 },
        ],
      },
      {
        name: 'A5',
        variants: [
          { name: '40 TFSI Sportback', yearStart: 2018, yearEnd: 2026 },
          { name: '45 TFSI Sportback', yearStart: 2018, yearEnd: 2026 },
          { name: 'S5 Sportback 3.0T', yearStart: 2019, yearEnd: 2026 },
          { name: 'RS5 Sportback 2.9T', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'A6',
        variants: [
          { name: '45 TFSI', yearStart: 2018, yearEnd: 2026 },
          { name: '55 TFSI Quattro', yearStart: 2018, yearEnd: 2026 },
          { name: 'S6 2.9T', yearStart: 2019, yearEnd: 2026 },
          { name: 'RS6 Avant 4.0T', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'A7',
        variants: [
          { name: '55 TFSI Quattro', yearStart: 2019, yearEnd: 2026 },
          { name: 'S7 2.9T', yearStart: 2020, yearEnd: 2026 },
          { name: 'RS7 Sportback 4.0T', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      { name: 'A8', variants: [
        { name: 'L 55 TFSI Quattro', yearStart: 2019, yearEnd: 2026 },
        { name: 'L 60 TFSI e PHEV', yearStart: 2020, yearEnd: 2026 },
        { name: 'S8 4.0T', yearStart: 2020, yearEnd: 2026 },
      ]},
      { name: 'Q2', variants: [{ name: '35 TFSI', yearStart: 2019, yearEnd: 2026 }] },
      { name: 'Q3', variants: [
        { name: '35 TFSI', yearStart: 2019, yearEnd: 2026 },
        { name: '40 TFSI Quattro', yearStart: 2019, yearEnd: 2026 },
        { name: 'RS Q3 2.5T', yearStart: 2020, yearEnd: 2026 },
      ]},
      { name: 'Q5', variants: [
        { name: '40 TFSI', yearStart: 2018, yearEnd: 2026 },
        { name: '45 TFSI Quattro', yearStart: 2018, yearEnd: 2026 },
        { name: 'SQ5 3.0T', yearStart: 2018, yearEnd: 2026 },
      ]},
      { name: 'Q7', variants: [
        { name: '45 TFSI Quattro', yearStart: 2018, yearEnd: 2026 },
        { name: '55 TFSI Quattro', yearStart: 2018, yearEnd: 2026 },
        { name: 'SQ7 4.0T', yearStart: 2020, yearEnd: 2026 },
      ]},
      { name: 'Q8', variants: [
        { name: '55 TFSI Quattro', yearStart: 2020, yearEnd: 2026 },
        { name: 'SQ8 4.0T', yearStart: 2020, yearEnd: 2026 },
        { name: 'RS Q8 4.0T', yearStart: 2020, yearEnd: 2026 },
      ]},
      { name: 'e-tron', variants: [
        { name: '50 Quattro', yearStart: 2021, yearEnd: 2024 },
        { name: '55 Quattro', yearStart: 2021, yearEnd: 2024 },
        { name: 'S e-tron', yearStart: 2022, yearEnd: 2024 },
        { name: 'GT RS', yearStart: 2022, yearEnd: 2026 },
      ]},
      { name: 'Q8 e-tron', variants: [
        { name: '55 Quattro', yearStart: 2024, yearEnd: 2026 },
        { name: 'SQ8 Sportback', yearStart: 2024, yearEnd: 2026 },
      ]},
      { name: 'R8', variants: [
        { name: 'V10 Performance 5.2', yearStart: 2019, yearEnd: 2024 },
      ]},
      { name: 'TT', variants: [
        { name: '45 TFSI', yearStart: 2018, yearEnd: 2024 },
        { name: 'RS 2.5T', yearStart: 2019, yearEnd: 2024 },
      ]},
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ LEXUS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Lexus',
    logo: `${LOGO_BASE}/lexus-logo.png`,
    models: [
      {
        name: 'LX',
        variants: [
          { name: '570 5.7 V8', yearStart: 2018, yearEnd: 2021 },
          { name: '600 3.5 Twin Turbo', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'GX',
        variants: [
          { name: '460 4.6 V8', yearStart: 2015, yearEnd: 2023 },
          { name: '550 2.4T (3rd Gen)', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'RX',
        variants: [
          { name: '350 3.5 V6', yearStart: 2018, yearEnd: 2024 },
          { name: '450h 3.5 Hybrid V6', yearStart: 2018, yearEnd: 2024 },
          { name: '350 2.4T (5th Gen)', yearStart: 2023, yearEnd: 2026 },
          { name: '350h Hybrid (5th Gen)', yearStart: 2023, yearEnd: 2026 },
          { name: '500h F Sport', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'NX',
        variants: [
          { name: '300 2.0T', yearStart: 2018, yearEnd: 2022 },
          { name: '300h 2.5 Hybrid', yearStart: 2018, yearEnd: 2022 },
          { name: '250 2.5 (2nd Gen)', yearStart: 2022, yearEnd: 2026 },
          { name: '350h Hybrid (2nd Gen)', yearStart: 2022, yearEnd: 2026 },
          { name: '450h+ PHEV (2nd Gen)', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'ES',
        variants: [
          { name: '250 2.5', yearStart: 2019, yearEnd: 2026 },
          { name: '300h 2.5 Hybrid', yearStart: 2018, yearEnd: 2026 },
          { name: '350 3.5 V6', yearStart: 2019, yearEnd: 2026 },
        ],
      },
      {
        name: 'IS',
        variants: [
          { name: '300 2.0T', yearStart: 2017, yearEnd: 2026 },
          { name: '300h 2.5 Hybrid', yearStart: 2017, yearEnd: 2026 },
          { name: '350 3.5 V6', yearStart: 2021, yearEnd: 2026 },
          { name: '500 F Sport Performance 5.0 V8', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'LS',
        variants: [
          { name: '500 3.5 Twin Turbo', yearStart: 2018, yearEnd: 2026 },
          { name: '500h 3.5 Hybrid', yearStart: 2018, yearEnd: 2026 },
        ],
      },
      {
        name: 'LC',
        variants: [
          { name: '500 5.0 V8', yearStart: 2018, yearEnd: 2026 },
          { name: '500h 3.5 Hybrid', yearStart: 2018, yearEnd: 2026 },
        ],
      },
      {
        name: 'UX',
        variants: [
          { name: '200 2.0', yearStart: 2019, yearEnd: 2026 },
          { name: '250h 2.0 Hybrid', yearStart: 2019, yearEnd: 2026 },
          { name: '300e EV', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'RZ',
        variants: [
          { name: '450e EV', yearStart: 2023, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ PORSCHE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Porsche',
    logo: `${LOGO_BASE}/porsche-logo.png`,
    models: [
      {
        name: 'Cayenne',
        variants: [
          { name: 'Base 3.0T', yearStart: 2018, yearEnd: 2026 },
          { name: 'S 2.9T', yearStart: 2018, yearEnd: 2026 },
          { name: 'GTS 4.0', yearStart: 2020, yearEnd: 2026 },
          { name: 'Turbo 4.0T', yearStart: 2018, yearEnd: 2026 },
          { name: 'Turbo GT 4.0T', yearStart: 2022, yearEnd: 2026 },
          { name: 'E-Hybrid 3.0T', yearStart: 2019, yearEnd: 2026 },
          { name: 'Coupe S 2.9T', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'Macan',
        variants: [
          { name: 'Base 2.0T', yearStart: 2018, yearEnd: 2024 },
          { name: 'S 3.0T', yearStart: 2018, yearEnd: 2024 },
          { name: 'GTS 2.9T', yearStart: 2020, yearEnd: 2024 },
          { name: 'Turbo 2.9T', yearStart: 2020, yearEnd: 2024 },
          { name: 'EV 4 (Electric)', yearStart: 2024, yearEnd: 2026 },
          { name: 'Turbo EV (Electric)', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: '911',
        variants: [
          { name: 'Carrera 3.0T', yearStart: 2019, yearEnd: 2026 },
          { name: 'Carrera S 3.0T', yearStart: 2019, yearEnd: 2026 },
          { name: 'Carrera 4S 3.0T', yearStart: 2019, yearEnd: 2026 },
          { name: 'GTS 3.0T', yearStart: 2022, yearEnd: 2026 },
          { name: 'Turbo 3.8T', yearStart: 2020, yearEnd: 2026 },
          { name: 'Turbo S 3.8T', yearStart: 2020, yearEnd: 2026 },
          { name: 'GT3 4.0', yearStart: 2022, yearEnd: 2026 },
          { name: 'GT3 RS 4.0', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Panamera',
        variants: [
          { name: 'Base 2.9T', yearStart: 2018, yearEnd: 2026 },
          { name: '4S 2.9T', yearStart: 2018, yearEnd: 2026 },
          { name: 'Turbo 4.0T', yearStart: 2018, yearEnd: 2024 },
          { name: 'Turbo S 4.0T', yearStart: 2021, yearEnd: 2024 },
          { name: '4 E-Hybrid 2.9T', yearStart: 2018, yearEnd: 2026 },
        ],
      },
      {
        name: 'Taycan',
        variants: [
          { name: 'Base EV', yearStart: 2021, yearEnd: 2026 },
          { name: '4S EV', yearStart: 2021, yearEnd: 2026 },
          { name: 'GTS EV', yearStart: 2022, yearEnd: 2026 },
          { name: 'Turbo EV', yearStart: 2021, yearEnd: 2026 },
          { name: 'Turbo S EV', yearStart: 2021, yearEnd: 2026 },
          { name: 'Cross Turismo Turbo S', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: '718 Cayman',
        variants: [
          { name: '2.0T', yearStart: 2018, yearEnd: 2026 },
          { name: 'S 2.5T', yearStart: 2018, yearEnd: 2026 },
          { name: 'GTS 4.0', yearStart: 2020, yearEnd: 2026 },
          { name: 'GT4 4.0', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: '718 Boxster',
        variants: [
          { name: '2.0T', yearStart: 2018, yearEnd: 2026 },
          { name: 'S 2.5T', yearStart: 2018, yearEnd: 2026 },
          { name: 'GTS 4.0', yearStart: 2020, yearEnd: 2026 },
          { name: 'Spyder 4.0', yearStart: 2020, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ LAND ROVER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Land Rover',
    logo: `${LOGO_BASE}/land-rover-logo.png`,
    models: [
      {
        name: 'Range Rover',
        variants: [
          { name: 'Vogue 3.0 Diesel', yearStart: 2018, yearEnd: 2022 },
          { name: 'Autobiography 5.0 V8', yearStart: 2018, yearEnd: 2022 },
          { name: 'SE 3.0 D350 (5th Gen)', yearStart: 2022, yearEnd: 2026 },
          { name: 'Autobiography 4.4 V8 (5th Gen)', yearStart: 2022, yearEnd: 2026 },
          { name: 'SV 4.4 V8 (5th Gen)', yearStart: 2023, yearEnd: 2026 },
          { name: 'P510e PHEV (5th Gen)', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Range Rover Sport',
        variants: [
          { name: 'HSE 3.0', yearStart: 2018, yearEnd: 2022 },
          { name: 'SVR 5.0 V8', yearStart: 2018, yearEnd: 2022 },
          { name: 'Dynamic SE P360 (3rd Gen)', yearStart: 2022, yearEnd: 2026 },
          { name: 'Autobiography D350 (3rd Gen)', yearStart: 2022, yearEnd: 2026 },
          { name: 'First Edition P530 V8 (3rd Gen)', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Range Rover Velar',
        variants: [
          { name: 'S P250', yearStart: 2018, yearEnd: 2026 },
          { name: 'R-Dynamic P250', yearStart: 2018, yearEnd: 2026 },
          { name: 'R-Dynamic HSE P400', yearStart: 2018, yearEnd: 2026 },
        ],
      },
      {
        name: 'Range Rover Evoque',
        variants: [
          { name: 'S P200', yearStart: 2018, yearEnd: 2026 },
          { name: 'SE P250', yearStart: 2018, yearEnd: 2026 },
          { name: 'R-Dynamic SE P300', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'Defender',
        variants: [
          { name: '90 P300', yearStart: 2020, yearEnd: 2026 },
          { name: '110 P300', yearStart: 2020, yearEnd: 2026 },
          { name: '110 P400', yearStart: 2020, yearEnd: 2026 },
          { name: '110 X P400', yearStart: 2021, yearEnd: 2026 },
          { name: '110 V8 5.0', yearStart: 2022, yearEnd: 2024 },
          { name: '130 P400', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Discovery',
        variants: [
          { name: 'S P300', yearStart: 2018, yearEnd: 2026 },
          { name: 'HSE D300', yearStart: 2018, yearEnd: 2026 },
          { name: 'R-Dynamic SE P360', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'Discovery Sport',
        variants: [
          { name: 'S P200', yearStart: 2020, yearEnd: 2026 },
          { name: 'R-Dynamic SE P250', yearStart: 2020, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ JEEP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Jeep',
    logo: `${LOGO_BASE}/jeep-logo.png`,
    models: [
      {
        name: 'Wrangler',
        variants: [
          { name: 'Sport 2.0T', yearStart: 2019, yearEnd: 2026 },
          { name: 'Sahara 2.0T', yearStart: 2019, yearEnd: 2026 },
          { name: 'Rubicon 2.0T', yearStart: 2019, yearEnd: 2026 },
          { name: 'Rubicon 3.6 V6', yearStart: 2019, yearEnd: 2026 },
          { name: 'Rubicon 392 6.4 V8', yearStart: 2021, yearEnd: 2024 },
          { name: '4xe PHEV 2.0T', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'Grand Cherokee',
        variants: [
          { name: 'Limited 3.6 V6', yearStart: 2019, yearEnd: 2026 },
          { name: 'Overland 5.7 V8', yearStart: 2019, yearEnd: 2024 },
          { name: 'Summit 3.6 V6', yearStart: 2022, yearEnd: 2026 },
          { name: 'Trackhawk 6.2 V8', yearStart: 2018, yearEnd: 2021 },
          { name: '4xe PHEV 2.0T', yearStart: 2022, yearEnd: 2026 },
          { name: 'L 3.6 V6 (3-Row)', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'Gladiator',
        variants: [
          { name: 'Sport 3.6 V6', yearStart: 2020, yearEnd: 2026 },
          { name: 'Rubicon 3.6 V6', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'Compass',
        variants: [
          { name: 'Sport 2.4', yearStart: 2018, yearEnd: 2025 },
          { name: 'Limited 2.4', yearStart: 2018, yearEnd: 2025 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ FORD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Ford',
    logo: `${LOGO_BASE}/ford-logo.png`,
    models: [
      {
        name: 'Mustang',
        variants: [
          { name: 'EcoBoost 2.3T', yearStart: 2018, yearEnd: 2026 },
          { name: 'GT 5.0 V8', yearStart: 2018, yearEnd: 2026 },
          { name: 'Mach 1 5.0 V8', yearStart: 2021, yearEnd: 2024 },
          { name: 'Shelby GT500 5.2 V8', yearStart: 2020, yearEnd: 2022 },
          { name: 'Dark Horse 5.0 V8 (7th Gen)', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Ranger',
        variants: [
          { name: 'XLT 2.0 Bi-Turbo', yearStart: 2019, yearEnd: 2026 },
          { name: 'Wildtrak 2.0 Bi-Turbo', yearStart: 2019, yearEnd: 2026 },
          { name: 'Raptor 2.0 Bi-Turbo', yearStart: 2019, yearEnd: 2022 },
          { name: 'Raptor 3.0 V6 EcoBoost', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Bronco',
        variants: [
          { name: 'Base 2.3T', yearStart: 2021, yearEnd: 2026 },
          { name: 'Badlands 2.7T', yearStart: 2021, yearEnd: 2026 },
          { name: 'Raptor 3.0T', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'Explorer',
        variants: [
          { name: 'Limited 2.3T', yearStart: 2019, yearEnd: 2024 },
          { name: 'ST 3.0T', yearStart: 2020, yearEnd: 2024 },
        ],
      },
      {
        name: 'Expedition',
        variants: [
          { name: 'XLT 3.5T V6', yearStart: 2018, yearEnd: 2024 },
          { name: 'Limited 3.5T V6', yearStart: 2018, yearEnd: 2024 },
        ],
      },
      {
        name: 'Mustang Mach-E',
        variants: [
          { name: 'Standard Range EV', yearStart: 2022, yearEnd: 2026 },
          { name: 'GT EV AWD', yearStart: 2022, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ VOLKSWAGEN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Volkswagen',
    logo: `${LOGO_BASE}/volkswagen-logo.png`,
    models: [
      {
        name: 'Golf',
        variants: [
          { name: '1.4 TSI', yearStart: 2018, yearEnd: 2024 },
          { name: 'GTI 2.0 TSI', yearStart: 2018, yearEnd: 2026 },
          { name: 'R 2.0 TSI', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'Polo',
        variants: [
          { name: '1.0 TSI', yearStart: 2018, yearEnd: 2024 },
          { name: 'GTI 2.0 TSI', yearStart: 2018, yearEnd: 2024 },
        ],
      },
      {
        name: 'Passat',
        variants: [
          { name: '2.0 TSI', yearStart: 2018, yearEnd: 2024 },
          { name: '2.0 TDI', yearStart: 2018, yearEnd: 2024 },
        ],
      },
      {
        name: 'Tiguan',
        variants: [
          { name: '1.4 TSI', yearStart: 2018, yearEnd: 2026 },
          { name: '2.0 TSI 4MOTION', yearStart: 2018, yearEnd: 2026 },
          { name: 'R 2.0 TSI 4MOTION', yearStart: 2022, yearEnd: 2026 },
        ],
      },
      {
        name: 'Touareg',
        variants: [
          { name: '3.0 V6 TSI', yearStart: 2019, yearEnd: 2026 },
          { name: '3.0 V6 TDI', yearStart: 2019, yearEnd: 2026 },
          { name: 'R 3.0 eHybrid PHEV', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'Arteon',
        variants: [
          { name: '2.0 TSI', yearStart: 2019, yearEnd: 2024 },
          { name: 'R 2.0 TSI 4MOTION', yearStart: 2021, yearEnd: 2024 },
        ],
      },
      {
        name: 'T-Roc',
        variants: [
          { name: '1.4 TSI', yearStart: 2020, yearEnd: 2026 },
          { name: '2.0 TSI 4MOTION', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'ID.4',
        variants: [
          { name: 'Pro EV', yearStart: 2022, yearEnd: 2026 },
          { name: 'GTX EV AWD', yearStart: 2022, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ VOLVO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Volvo',
    logo: `${LOGO_BASE}/volvo-logo.png`,
    models: [
      {
        name: 'S60',
        variants: [
          { name: 'B5 Mild Hybrid', yearStart: 2019, yearEnd: 2026 },
          { name: 'T8 Recharge PHEV', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'S90',
        variants: [
          { name: 'B5 Mild Hybrid', yearStart: 2019, yearEnd: 2026 },
          { name: 'T8 Recharge PHEV', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'XC40',
        variants: [
          { name: 'B4 Mild Hybrid', yearStart: 2019, yearEnd: 2026 },
          { name: 'Recharge EV', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'XC60',
        variants: [
          { name: 'B5 Mild Hybrid', yearStart: 2018, yearEnd: 2026 },
          { name: 'B6 Mild Hybrid AWD', yearStart: 2020, yearEnd: 2026 },
          { name: 'T8 Recharge PHEV', yearStart: 2018, yearEnd: 2026 },
        ],
      },
      {
        name: 'XC90',
        variants: [
          { name: 'B5 Mild Hybrid', yearStart: 2018, yearEnd: 2026 },
          { name: 'B6 Mild Hybrid AWD', yearStart: 2020, yearEnd: 2026 },
          { name: 'T8 Recharge PHEV', yearStart: 2018, yearEnd: 2026 },
        ],
      },
      {
        name: 'EX30',
        variants: [
          { name: 'Single Motor EV', yearStart: 2024, yearEnd: 2026 },
          { name: 'Twin Motor EV AWD', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'EX90',
        variants: [
          { name: 'Twin Motor EV AWD', yearStart: 2024, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ TESLA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Tesla',
    logo: `${LOGO_BASE}/tesla-logo.png`,
    models: [
      {
        name: 'Model 3',
        variants: [
          { name: 'Standard Range+', yearStart: 2020, yearEnd: 2026 },
          { name: 'Long Range AWD', yearStart: 2020, yearEnd: 2026 },
          { name: 'Performance', yearStart: 2020, yearEnd: 2024 },
          { name: 'Highland Long Range', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Model Y',
        variants: [
          { name: 'Standard Range', yearStart: 2021, yearEnd: 2026 },
          { name: 'Long Range AWD', yearStart: 2021, yearEnd: 2026 },
          { name: 'Performance', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'Model S',
        variants: [
          { name: 'Long Range', yearStart: 2021, yearEnd: 2026 },
          { name: 'Plaid', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'Model X',
        variants: [
          { name: 'Long Range', yearStart: 2021, yearEnd: 2026 },
          { name: 'Plaid', yearStart: 2021, yearEnd: 2026 },
        ],
      },
      {
        name: 'Cybertruck',
        variants: [
          { name: 'AWD', yearStart: 2024, yearEnd: 2026 },
          { name: 'Cyberbeast', yearStart: 2024, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ BENTLEY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Bentley',
    logo: `${LOGO_BASE}/bentley-logo.png`,
    models: [
      {
        name: 'Bentayga',
        variants: [
          { name: 'V8 4.0T', yearStart: 2018, yearEnd: 2026 },
          { name: 'Speed W12 6.0T', yearStart: 2020, yearEnd: 2024 },
          { name: 'EWB V8 4.0T', yearStart: 2022, yearEnd: 2026 },
          { name: 'S V8 4.0T', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'Continental GT',
        variants: [
          { name: 'V8 4.0T', yearStart: 2019, yearEnd: 2026 },
          { name: 'Speed W12 6.0T', yearStart: 2019, yearEnd: 2024 },
          { name: 'GTC V8 4.0T Convertible', yearStart: 2019, yearEnd: 2026 },
        ],
      },
      {
        name: 'Flying Spur',
        variants: [
          { name: 'V8 4.0T', yearStart: 2020, yearEnd: 2026 },
          { name: 'W12 6.0T', yearStart: 2020, yearEnd: 2024 },
          { name: 'Mulliner W12', yearStart: 2022, yearEnd: 2024 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ MASERATI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Maserati',
    logo: `${LOGO_BASE}/maserati-logo.png`,
    models: [
      {
        name: 'Levante',
        variants: [
          { name: 'GT 3.0 V6', yearStart: 2019, yearEnd: 2024 },
          { name: 'Modena 3.0 V6', yearStart: 2022, yearEnd: 2024 },
          { name: 'Trofeo 3.8 V8', yearStart: 2021, yearEnd: 2024 },
        ],
      },
      {
        name: 'Ghibli',
        variants: [
          { name: 'GT 3.0 V6', yearStart: 2018, yearEnd: 2024 },
          { name: 'Modena 3.0 V6', yearStart: 2022, yearEnd: 2024 },
          { name: 'Trofeo 3.8 V8', yearStart: 2021, yearEnd: 2024 },
        ],
      },
      {
        name: 'Quattroporte',
        variants: [
          { name: 'GT 3.0 V6', yearStart: 2018, yearEnd: 2024 },
          { name: 'Modena 3.0 V6', yearStart: 2022, yearEnd: 2024 },
        ],
      },
      {
        name: 'GranTurismo',
        variants: [
          { name: 'Modena 3.0 V6', yearStart: 2023, yearEnd: 2026 },
          { name: 'Trofeo 3.0 V6', yearStart: 2023, yearEnd: 2026 },
          { name: 'Folgore EV', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Grecale',
        variants: [
          { name: 'GT 2.0 Turbo', yearStart: 2023, yearEnd: 2026 },
          { name: 'Modena 2.0 Turbo', yearStart: 2023, yearEnd: 2026 },
          { name: 'Trofeo 3.0 V6', yearStart: 2023, yearEnd: 2026 },
          { name: 'Folgore EV', yearStart: 2024, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ LAMBORGHINI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Lamborghini',
    logo: `${LOGO_BASE}/lamborghini-logo.png`,
    models: [
      {
        name: 'Urus',
        variants: [
          { name: '4.0T V8', yearStart: 2019, yearEnd: 2024 },
          { name: 'Performante 4.0T V8', yearStart: 2023, yearEnd: 2026 },
          { name: 'S 4.0T V8', yearStart: 2022, yearEnd: 2026 },
          { name: 'SE PHEV', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: 'Huracan',
        variants: [
          { name: 'EVO 5.2 V10', yearStart: 2019, yearEnd: 2024 },
          { name: 'Tecnica 5.2 V10', yearStart: 2022, yearEnd: 2024 },
          { name: 'STO 5.2 V10', yearStart: 2022, yearEnd: 2024 },
          { name: 'Sterrato 5.2 V10', yearStart: 2023, yearEnd: 2024 },
        ],
      },
      {
        name: 'Revuelto',
        variants: [
          { name: '6.5 V12 PHEV', yearStart: 2024, yearEnd: 2026 },
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ FERRARI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Ferrari',
    logo: `${LOGO_BASE}/ferrari-logo.png`,
    models: [
      {
        name: 'Roma',
        variants: [
          { name: '3.9T V8', yearStart: 2020, yearEnd: 2026 },
        ],
      },
      {
        name: 'F8',
        variants: [
          { name: 'Tributo 3.9T V8', yearStart: 2020, yearEnd: 2024 },
          { name: 'Spider 3.9T V8', yearStart: 2020, yearEnd: 2024 },
        ],
      },
      {
        name: '296',
        variants: [
          { name: 'GTB 3.0 V6 PHEV', yearStart: 2022, yearEnd: 2026 },
          { name: 'GTS 3.0 V6 PHEV', yearStart: 2023, yearEnd: 2026 },
        ],
      },
      {
        name: 'SF90',
        variants: [
          { name: 'Stradale 4.0T V8 PHEV', yearStart: 2021, yearEnd: 2026 },
          { name: 'Spider 4.0T V8 PHEV', yearStart: 2021, yearEnd: 2026 },
          { name: 'XX Stradale 4.0T V8 PHEV', yearStart: 2024, yearEnd: 2026 },
        ],
      },
      {
        name: '812',
        variants: [
          { name: 'Superfast 6.5 V12', yearStart: 2018, yearEnd: 2022 },
          { name: 'GTS 6.5 V12', yearStart: 2022, yearEnd: 2024 },
          { name: 'Competizione 6.5 V12', yearStart: 2022, yearEnd: 2024 },
        ],
      },
      {
        name: 'Purosangue',
        variants: [
          { name: '6.5 V12', yearStart: 2023, yearEnd: 2026 },
        ],
      },
    ],
  },
];

async function seed() {
  try {
    const mongoUri =
      process.env.MONGO_URI || 'mongodb://localhost:27017/hamzaMobile';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    let createdMakes = 0;
    let createdModels = 0;
    let createdVariants = 0;
    let skippedMakes = 0;
    let skippedModels = 0;
    let skippedVariants = 0;

    for (const makeEntry of data) {
      const makeName = titleCase(makeEntry.make);

      // Upsert make
      let make = await CarMake.findOne({ name: makeName });
      if (!make) {
        try {
          make = await CarMake.create({
            name: makeName,
            logoUrl: makeEntry.logo || '',
            active: true,
          });
          createdMakes++;
          console.log(`  + Make: ${makeName}`);
        } catch (err) {
          if (err && err.code === 11000) {
            make = await CarMake.findOne({ name: makeName });
            skippedMakes++;
          } else {
            throw err;
          }
        }
      } else {
        // Update existing make with new logo if seed provides one and DB is empty
        if (makeEntry.logo && !make.logoUrl) {
          make.logoUrl = makeEntry.logo;
          await make.save();
        }
        skippedMakes++;
      }

      for (const modelEntry of makeEntry.models) {
        const modelName = titleCase(modelEntry.name);

        let model = await CarModel.findOne({ makeId: make._id, name: modelName });
        if (!model) {
          try {
            model = await CarModel.create({
              makeId: make._id,
              name: modelName,
              active: true,
            });
            createdModels++;
          } catch (err) {
            if (err && err.code === 11000) {
              model = await CarModel.findOne({ makeId: make._id, name: modelName });
              skippedModels++;
            } else {
              throw err;
            }
          }
        } else {
          skippedModels++;
        }

        for (const v of modelEntry.variants) {
          const variantName = String(v.name || '').trim();
          const yearStart = v.yearStart ?? null;
          const yearEnd = v.yearEnd ?? null;

          const existing = await CarVariant.findOne({
            modelId: model._id,
            name: variantName,
            yearStart,
            yearEnd,
          });
          if (existing) {
            skippedVariants++;
            continue;
          }

          try {
            await CarVariant.create({
              modelId: model._id,
              name: variantName,
              yearStart,
              yearEnd,
              active: true,
            });
            createdVariants++;
          } catch (err) {
            if (err && err.code === 11000) {
              skippedVariants++;
              continue;
            }
            throw err;
          }
        }
      }
    }

    console.log('\n========================================');
    console.log('Car hierarchy seeded successfully!');
    console.log('========================================');
    console.log(`Makes    â€” created: ${createdMakes}, skipped: ${skippedMakes}`);
    console.log(`Models   â€” created: ${createdModels}, skipped: ${skippedModels}`);
    console.log(`Variants â€” created: ${createdVariants}, skipped: ${skippedVariants}`);

    // Summary
    const totalMakes = await CarMake.countDocuments();
    const totalModels = await CarModel.countDocuments();
    const totalVariants = await CarVariant.countDocuments();
    console.log(`\nTotal in DB:`);
    console.log(`  Makes: ${totalMakes}`);
    console.log(`  Models: ${totalModels}`);
    console.log(`  Variants: ${totalVariants}`);
  } catch (error) {
    console.error('Error seeding car hierarchy:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

seed();
