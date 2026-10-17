// src/seeds/seedCars.js
//
// Comprehensive car seeder for the Pakistan market â€” covers locally
// assembled brands (Toyota IMC, Honda Atlas, Pak Suzuki, Hyundai Nishat,
// Kia Lucky, MG, Changan, Haval, Proton, BAIC, JAC, DFSK, United) plus
// commonly imported JDM and European cars.
//
// The seeder is idempotent â€” re-running only adds new (make, model,
// variant, year) combinations that don't already exist.

const mongoose = require('mongoose');
const Car = require('../models/car');
require('dotenv').config();

/**
 * Mirror the title-case normalization applied by the Car model's pre('save')
 * hook so existence checks match records the model would create.
 */
const titleCase = (str) => {
  const s = String(str || '').trim();
  if (!s) return s;
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
};

/**
 * Helper: expand a base variant across a range of years.
 * Keeps the data compact and readable.
 */
const range = (start, end) => {
  const years = [];
  for (let y = start; y <= end; y++) years.push(y);
  return years;
};
const years = (variant, start, end) =>
  range(start, end).map((year) => ({ variant, year }));

/**
 * Seed data grouped by make â†’ model â†’ variants[]
 */
const carsData = [
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // TOYOTA (Indus Motor Company + JDM imports)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Toyota',
    models: [
      {
        name: 'Corolla',
        variants: [
          ...years('XLi 1.3', 2015, 2020),
          ...years('GLi 1.3', 2015, 2020),
          ...years('GLi 1.6', 2015, 2023),
          ...years('Altis 1.6', 2015, 2023),
          ...years('Altis Grande 1.8', 2015, 2023),
          ...years('Altis X 1.6', 2021, 2023),
          ...years('Altis X CVT-i 1.8', 2022, 2024),
        ],
      },
      {
        name: 'Yaris',
        variants: [
          ...years('GLi MT 1.3', 2020, 2024),
          ...years('GLi CVT 1.3', 2020, 2024),
          ...years('ATIV MT 1.3', 2020, 2024),
          ...years('ATIV CVT 1.3', 2020, 2024),
          ...years('ATIV X MT 1.5', 2020, 2024),
          ...years('ATIV X CVT 1.5', 2020, 2024),
          ...years('Aero 1.5', 2023, 2024),
        ],
      },
      {
        name: 'Corolla Cross',
        variants: [
          { variant: 'HEV 1.8', year: 2024 },
          { variant: 'Smart 1.8', year: 2024 },
        ],
      },
      {
        name: 'Hilux',
        variants: [
          ...years('Revo G 2.8', 2016, 2024),
          ...years('Revo V 2.8', 2016, 2024),
          ...years('Revo Rocco 2.8', 2018, 2024),
          ...years('E 2.5', 2016, 2020),
          ...years('Revo GR Sport', 2023, 2024),
        ],
      },
      {
        name: 'Fortuner',
        variants: [
          ...years('2.7 G', 2016, 2024),
          ...years('Sigma 4 2.7', 2018, 2024),
          ...years('Legender 2.8', 2021, 2024),
          ...years('GR-S 2.8', 2023, 2024),
          ...years('V 2.8 Diesel', 2016, 2024),
        ],
      },
      {
        name: 'Land Cruiser',
        variants: [
          ...years('ZX 4.5 Diesel', 2015, 2021),
          ...years('VX 4.5 Diesel', 2015, 2021),
          ...years('LC300 ZX 3.3', 2022, 2024),
          ...years('LC300 VX 3.3', 2022, 2024),
        ],
      },
      {
        name: 'Prado',
        variants: [
          ...years('TX 2.7', 2015, 2023),
          ...years('TXL 2.7', 2015, 2023),
          ...years('TZ-G 4.0', 2015, 2023),
        ],
      },
      {
        name: 'Camry',
        variants: [
          ...years('2.5 G', 2018, 2024),
          ...years('Hybrid 2.5', 2020, 2024),
        ],
      },
      {
        name: 'Vitz',
        variants: [
          ...years('F 1.0', 2015, 2019),
          ...years('F 1.3', 2015, 2019),
          ...years('Jewela 1.0', 2016, 2019),
        ],
      },
      {
        name: 'Aqua',
        variants: [
          ...years('S 1.5 Hybrid', 2015, 2022),
          ...years('G 1.5 Hybrid', 2015, 2022),
          ...years('Crossover 1.5 Hybrid', 2018, 2022),
        ],
      },
      {
        name: 'Passo',
        variants: [...years('X 1.0', 2015, 2022)],
      },
      {
        name: 'Prius',
        variants: [
          ...years('S 1.8 Hybrid', 2016, 2023),
          ...years('A 1.8 Hybrid', 2016, 2023),
        ],
      },
      {
        name: 'Hiace',
        variants: [
          ...years('GL 2.5 Diesel', 2018, 2024),
          ...years('Grand Cabin 2.7', 2018, 2024),
          ...years('Commuter 2.8', 2018, 2024),
        ],
      },
      {
        name: 'Avanza',
        variants: [...years('1.5 G', 2015, 2022)],
      },
      {
        name: 'Rush',
        variants: [...years('G 1.5', 2018, 2023)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // HONDA (Atlas Honda + JDM imports)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Honda',
    models: [
      {
        name: 'Civic',
        variants: [
          ...years('VTi 1.8', 2016, 2021),
          ...years('VTi Oriel 1.8', 2016, 2021),
          ...years('Oriel UG 1.8', 2019, 2021),
          ...years('RS Turbo 1.5', 2019, 2024),
          ...years('LX 1.8', 2022, 2024),
          ...years('EX 1.8', 2022, 2024),
        ],
      },
      {
        name: 'City',
        variants: [
          ...years('i-VTEC Prosmatec 1.3', 2015, 2021),
          ...years('1.5 Aspire', 2015, 2021),
          ...years('1.2L CVT', 2022, 2024),
          ...years('1.5L Aspire CVT', 2022, 2024),
        ],
      },
      {
        name: 'BR-V',
        variants: [
          ...years('i-VTEC S 1.5', 2017, 2021),
          ...years('i-VTEC VX 1.5', 2017, 2021),
          ...years('S CVT 1.5', 2022, 2024),
          ...years('VX CVT 1.5', 2022, 2024),
        ],
      },
      {
        name: 'HR-V',
        variants: [
          ...years('VTi 1.8', 2022, 2024),
          ...years('VTi-S 1.8', 2022, 2024),
          ...years('e:HEV 1.5', 2023, 2024),
        ],
      },
      {
        name: 'Accord',
        variants: [
          ...years('Sport 1.5 Turbo', 2018, 2023),
          ...years('Touring 2.0 Turbo', 2018, 2023),
        ],
      },
      {
        name: 'Vezel',
        variants: [
          ...years('Hybrid X 1.5', 2016, 2022),
          ...years('Hybrid Z 1.5', 2016, 2022),
          ...years('RS 1.5', 2018, 2022),
        ],
      },
      {
        name: 'Fit',
        variants: [
          ...years('Hybrid 1.5', 2015, 2021),
          ...years('13G 1.3', 2015, 2021),
        ],
      },
      {
        name: 'N-WGN',
        variants: [...years('G 660', 2016, 2022)],
      },
      {
        name: 'N-Box',
        variants: [...years('G 660', 2016, 2022)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // SUZUKI (Pak Suzuki + JDM imports)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Suzuki',
    models: [
      {
        name: 'Alto',
        variants: [
          ...years('VX 660', 2019, 2024),
          ...years('VXR 660', 2019, 2024),
          ...years('VXL AGS 660', 2019, 2024),
        ],
      },
      {
        name: 'Cultus',
        variants: [
          ...years('VXR 1.0', 2017, 2023),
          ...years('VXL 1.0', 2017, 2023),
          ...years('AGS 1.0', 2019, 2023),
        ],
      },
      {
        name: 'Wagon R',
        variants: [
          ...years('VXR 1.0', 2014, 2023),
          ...years('VXL 1.0', 2014, 2023),
          ...years('AGS 1.0', 2018, 2023),
        ],
      },
      {
        name: 'Swift',
        variants: [
          ...years('GL MT 1.2', 2022, 2024),
          ...years('GL CVT 1.2', 2022, 2024),
          ...years('GLX CVT 1.2', 2022, 2024),
        ],
      },
      {
        name: 'Bolan',
        variants: [
          ...years('Cargo Van', 2015, 2024),
          ...years('Hiroof VX', 2015, 2024),
        ],
      },
      {
        name: 'Ravi',
        variants: [...years('Standard 800', 2015, 2024)],
      },
      {
        name: 'Mehran',
        variants: [
          ...years('VX 800', 2015, 2019),
          ...years('VXR 800', 2015, 2019),
        ],
      },
      {
        name: 'Every',
        variants: [
          ...years('GA 660', 2016, 2023),
          ...years('PC 660', 2016, 2023),
          ...years('Landy 660', 2018, 2023),
        ],
      },
      {
        name: 'Hustler',
        variants: [...years('J Style 660', 2018, 2023)],
      },
      {
        name: 'Spacia',
        variants: [...years('Custom 660', 2018, 2023)],
      },
      {
        name: 'APV',
        variants: [...years('GLX 1.5', 2015, 2021)],
      },
      {
        name: 'Jimny',
        variants: [
          ...years('JLX 1.3', 2018, 2024),
          ...years('Sierra 1.5', 2019, 2024),
        ],
      },
      {
        name: 'Vitara',
        variants: [...years('GLX 1.6', 2015, 2020)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // HYUNDAI (Hyundai Nishat)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Hyundai',
    models: [
      {
        name: 'Tucson',
        variants: [
          ...years('GLS Sport FWD 2.0', 2021, 2024),
          ...years('Ultimate AWD 2.0', 2021, 2024),
        ],
      },
      {
        name: 'Sonata',
        variants: [
          ...years('GLS 2.0', 2021, 2024),
          ...years('GLS 2.5', 2021, 2024),
        ],
      },
      {
        name: 'Elantra',
        variants: [
          ...years('GLS 1.6', 2021, 2023),
          ...years('GLS 2.0', 2021, 2023),
        ],
      },
      {
        name: 'Porter H-100',
        variants: [...years('2.5 Diesel', 2022, 2024)],
      },
      {
        name: 'Ioniq 5',
        variants: [...years('Long Range EV', 2023, 2024)],
      },
      {
        name: 'Santa Fe',
        variants: [...years('Signature 2.5', 2023, 2024)],
      },
      {
        name: 'Staria',
        variants: [...years('Lounge 2.2 CRDi', 2023, 2024)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // KIA (Kia Lucky Motor)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Kia',
    models: [
      {
        name: 'Sportage',
        variants: [
          ...years('Alpha FWD 2.0', 2019, 2024),
          ...years('FWD 2.0', 2019, 2024),
          ...years('AWD 2.0', 2019, 2024),
          ...years('Black Edition', 2022, 2024),
          ...years('FHEV AWD 1.6', 2023, 2024),
        ],
      },
      {
        name: 'Picanto',
        variants: [
          ...years('Manual 1.0', 2019, 2023),
          ...years('Automatic 1.0', 2019, 2023),
        ],
      },
      {
        name: 'Stonic',
        variants: [
          ...years('EX 1.4', 2021, 2024),
          ...years('EX+ 1.4', 2021, 2024),
        ],
      },
      {
        name: 'Sorento',
        variants: [
          ...years('2.4 FWD', 2020, 2024),
          ...years('2.4 AWD', 2020, 2024),
          ...years('3.5 V6 AWD', 2021, 2024),
        ],
      },
      {
        name: 'Carnival',
        variants: [
          ...years('EX 3.5', 2022, 2024),
          ...years('SX 3.5', 2022, 2024),
        ],
      },
      {
        name: 'EV6',
        variants: [...years('GT Line AWD', 2023, 2024)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // MG (JW SEZ MG Motors)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'MG',
    models: [
      {
        name: 'HS',
        variants: [
          ...years('Core 1.5T', 2020, 2024),
          ...years('Excite 1.5T', 2020, 2024),
          ...years('Essence 1.5T', 2020, 2024),
          ...years('PHEV 1.5T', 2022, 2024),
        ],
      },
      {
        name: 'ZS',
        variants: [
          ...years('Luxury 1.5', 2022, 2024),
          ...years('Alpha 1.5', 2022, 2024),
          ...years('EV', 2023, 2024),
        ],
      },
      {
        name: '5',
        variants: [...years('EV', 2024, 2024)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // CHANGAN (Master Motors)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Changan',
    models: [
      {
        name: 'Alsvin',
        variants: [
          ...years('Comfort MT 1.5', 2021, 2024),
          ...years('Comfort DCT 1.5', 2021, 2024),
          ...years('Lumiere DCT 1.5', 2021, 2024),
        ],
      },
      {
        name: 'Oshan X7',
        variants: [...years('FutureSense 1.5T', 2022, 2024)],
      },
      {
        name: 'Karvaan',
        variants: [
          ...years('Standard 1.0', 2021, 2024),
          ...years('Plus 1.0', 2021, 2024),
        ],
      },
      {
        name: 'M9',
        variants: [...years('Pickup 1.2', 2022, 2024)],
      },
      {
        name: 'Deepal L07',
        variants: [...years('EV', 2024, 2024)],
      },
      {
        name: 'Deepal S07',
        variants: [...years('EV', 2024, 2024)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // HAVAL (Sazgar)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Haval',
    models: [
      {
        name: 'H6',
        variants: [
          ...years('1.5T 2WD', 2022, 2024),
          ...years('2.0T AWD', 2022, 2024),
          ...years('HEV 1.5T', 2023, 2024),
        ],
      },
      {
        name: 'Jolion',
        variants: [
          ...years('1.5T', 2023, 2024),
          ...years('HEV 1.5T', 2023, 2024),
        ],
      },
      {
        name: 'H6 GT',
        variants: [...years('2.0T AWD', 2024, 2024)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // PROTON (Al-Haj Automotive)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Proton',
    models: [
      {
        name: 'Saga',
        variants: [
          ...years('Standard 1.3', 2021, 2024),
          ...years('Ace 1.3', 2021, 2024),
          ...years('R3 1.3', 2022, 2024),
        ],
      },
      {
        name: 'X70',
        variants: [
          ...years('Executive 1.5T', 2020, 2024),
          ...years('Premium 1.5T', 2020, 2024),
          ...years('Premium FL 1.5T', 2022, 2024),
        ],
      },
      {
        name: 'X50',
        variants: [
          ...years('Executive 1.5T', 2024, 2024),
          ...years('Flagship 1.5T', 2024, 2024),
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // BAIC (Sazgar)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'BAIC',
    models: [
      {
        name: 'D20',
        variants: [
          ...years('Hatchback 1.5', 2023, 2024),
          ...years('Sedan 1.5', 2023, 2024),
        ],
      },
      {
        name: 'BJ40',
        variants: [...years('Plus 2.0T', 2023, 2024)],
      },
      {
        name: 'X55',
        variants: [...years('Elite 1.5T', 2024, 2024)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // JAC (Ghandhara)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'JAC',
    models: [
      {
        name: 'X200',
        variants: [...years('Pickup 2.8 Diesel', 2021, 2024)],
      },
      {
        name: 'T6',
        variants: [
          ...years('2.0 Petrol', 2022, 2024),
          ...years('2.0 Diesel', 2022, 2024),
        ],
      },
      {
        name: 'T8',
        variants: [...years('2.0T Diesel', 2023, 2024)],
      },
      {
        name: 'T9',
        variants: [...years('2.0T Diesel', 2024, 2024)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // DFSK / Prince
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'DFSK',
    models: [
      {
        name: 'Prince K01',
        variants: [...years('Loader', 2019, 2024)],
      },
      {
        name: 'Prince Pearl',
        variants: [
          ...years('Standard 800', 2019, 2023),
          ...years('REX 800', 2020, 2023),
        ],
      },
      {
        name: 'Glory 580',
        variants: [
          ...years('Pro 1.5T', 2019, 2023),
          ...years('Comfort 1.5T', 2019, 2023),
        ],
      },
      {
        name: 'Glory 500',
        variants: [...years('1.5 MT', 2019, 2022)],
      },
      {
        name: 'Honor Plus',
        variants: [...years('Pickup 1.5', 2020, 2024)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // UNITED MOTORS
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'United',
    models: [
      {
        name: 'Bravo',
        variants: [
          ...years('Standard 800', 2019, 2024),
          ...years('VXL 800', 2019, 2024),
        ],
      },
      {
        name: 'Alpha',
        variants: [...years('Pickup 1.0', 2020, 2024)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // CHERY (Regal)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Chery',
    models: [
      {
        name: 'Tiggo 4 Pro',
        variants: [...years('Comfort 1.5', 2024, 2024)],
      },
      {
        name: 'Tiggo 8 Pro',
        variants: [...years('Premium 2.0T', 2024, 2024)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // NISSAN (mostly JDM imports)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Nissan',
    models: [
      {
        name: 'Dayz',
        variants: [
          ...years('Highway Star 660', 2015, 2022),
          ...years('X 660', 2015, 2022),
        ],
      },
      {
        name: 'Roox',
        variants: [...years('Highway Star 660', 2018, 2022)],
      },
      {
        name: 'Moco',
        variants: [...years('X 660', 2015, 2020)],
      },
      {
        name: 'Sunny',
        variants: [
          ...years('EX Saloon 1.3', 2014, 2018),
          ...years('Super Saloon 1.6', 2014, 2018),
        ],
      },
      {
        name: 'Note',
        variants: [
          ...years('e-Power 1.2', 2017, 2022),
          ...years('Medalist 1.2', 2016, 2022),
        ],
      },
      {
        name: 'X-Trail',
        variants: [
          ...years('20X 2.0', 2016, 2022),
          ...years('Hybrid 2.0', 2017, 2022),
        ],
      },
      {
        name: 'Juke',
        variants: [...years('15RX 1.5', 2015, 2019)],
      },
      {
        name: 'Patrol',
        variants: [...years('Y62 5.6', 2018, 2024)],
      },
      {
        name: 'Navara',
        variants: [...years('LE 2.5 Diesel', 2018, 2023)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // MITSUBISHI (imports)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Mitsubishi',
    models: [
      {
        name: 'Mirage',
        variants: [...years('GLS 1.2', 2015, 2022)],
      },
      {
        name: 'Lancer',
        variants: [
          ...years('GLX 1.3', 2013, 2017),
          ...years('GLX 1.5', 2013, 2017),
        ],
      },
      {
        name: 'Outlander',
        variants: [
          ...years('Sport 2.0', 2015, 2022),
          ...years('PHEV 2.4', 2018, 2023),
        ],
      },
      {
        name: 'Pajero',
        variants: [
          ...years('GLS 3.0', 2015, 2021),
          ...years('Exceed 3.2 Diesel', 2015, 2021),
        ],
      },
      {
        name: 'Eclipse Cross',
        variants: [...years('1.5T', 2019, 2023)],
      },
      {
        name: 'L200 Triton',
        variants: [...years('2.4 Diesel', 2018, 2023)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // DAIHATSU (imports)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Daihatsu',
    models: [
      {
        name: 'Mira',
        variants: [
          ...years('X 660', 2015, 2022),
          ...years('L SA 660', 2015, 2022),
        ],
      },
      {
        name: 'Move',
        variants: [
          ...years('X 660', 2015, 2022),
          ...years('Custom X 660', 2015, 2022),
        ],
      },
      {
        name: 'Tanto',
        variants: [
          ...years('X 660', 2015, 2022),
          ...years('Custom RS 660', 2015, 2022),
        ],
      },
      {
        name: 'Hijet',
        variants: [...years('Cargo 660', 2015, 2022)],
      },
      {
        name: 'Copen',
        variants: [...years('Cero 660', 2015, 2022)],
      },
      {
        name: 'Cast',
        variants: [...years('Activa G 660', 2015, 2022)],
      },
      {
        name: 'Mira e:S',
        variants: [...years('660', 2017, 2022)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // BMW (imports)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'BMW',
    models: [
      {
        name: '3 Series',
        variants: [
          ...years('320i', 2018, 2024),
          ...years('330i', 2018, 2024),
          ...years('330e PHEV', 2020, 2024),
        ],
      },
      {
        name: '5 Series',
        variants: [
          ...years('520i', 2018, 2024),
          ...years('530i', 2018, 2024),
          ...years('530e PHEV', 2020, 2024),
        ],
      },
      {
        name: '7 Series',
        variants: [...years('740Li', 2018, 2024)],
      },
      {
        name: 'X1',
        variants: [...years('sDrive20i', 2018, 2024)],
      },
      {
        name: 'X3',
        variants: [...years('xDrive30i', 2018, 2024)],
      },
      {
        name: 'X5',
        variants: [...years('xDrive40i', 2018, 2024)],
      },
      {
        name: 'X7',
        variants: [...years('xDrive40i', 2020, 2024)],
      },
      {
        name: 'i4',
        variants: [...years('eDrive40', 2023, 2024)],
      },
      {
        name: 'iX',
        variants: [...years('xDrive50', 2023, 2024)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // MERCEDES-BENZ (imports)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Mercedes-Benz',
    models: [
      {
        name: 'C-Class',
        variants: [
          ...years('C200', 2018, 2024),
          ...years('C300', 2018, 2024),
        ],
      },
      {
        name: 'E-Class',
        variants: [
          ...years('E200', 2018, 2024),
          ...years('E300', 2018, 2024),
          ...years('E350', 2018, 2024),
        ],
      },
      {
        name: 'S-Class',
        variants: [
          ...years('S450', 2018, 2024),
          ...years('S500', 2018, 2024),
        ],
      },
      {
        name: 'GLA',
        variants: [...years('GLA200', 2019, 2024)],
      },
      {
        name: 'GLC',
        variants: [
          ...years('GLC200', 2018, 2024),
          ...years('GLC300', 2018, 2024),
        ],
      },
      {
        name: 'GLE',
        variants: [
          ...years('GLE450', 2019, 2024),
          ...years('GLE53 AMG', 2020, 2024),
        ],
      },
      {
        name: 'G-Class',
        variants: [...years('G63 AMG', 2019, 2024)],
      },
      {
        name: 'EQE',
        variants: [...years('350+', 2023, 2024)],
      },
      {
        name: 'EQS',
        variants: [...years('450+', 2023, 2024)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // AUDI (imports)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Audi',
    models: [
      {
        name: 'A3',
        variants: [...years('35 TFSI', 2018, 2024)],
      },
      {
        name: 'A4',
        variants: [
          ...years('35 TFSI', 2018, 2024),
          ...years('40 TFSI', 2018, 2024),
        ],
      },
      {
        name: 'A6',
        variants: [
          ...years('45 TFSI', 2018, 2024),
          ...years('55 TFSI', 2018, 2024),
        ],
      },
      {
        name: 'A8',
        variants: [...years('L 55 TFSI', 2019, 2024)],
      },
      {
        name: 'Q3',
        variants: [...years('35 TFSI', 2019, 2024)],
      },
      {
        name: 'Q5',
        variants: [...years('45 TFSI', 2018, 2024)],
      },
      {
        name: 'Q7',
        variants: [...years('55 TFSI', 2018, 2024)],
      },
      {
        name: 'Q8',
        variants: [...years('55 TFSI', 2020, 2024)],
      },
      {
        name: 'e-tron',
        variants: [...years('55 Quattro', 2021, 2024)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // LEXUS (imports)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Lexus',
    models: [
      {
        name: 'LX',
        variants: [
          ...years('570 5.7', 2018, 2021),
          ...years('600 3.5', 2022, 2024),
        ],
      },
      {
        name: 'RX',
        variants: [
          ...years('350 3.5', 2018, 2024),
          ...years('450h 3.5 Hybrid', 2018, 2024),
        ],
      },
      {
        name: 'LS',
        variants: [...years('500h 3.5 Hybrid', 2018, 2024)],
      },
      {
        name: 'ES',
        variants: [
          ...years('300h 2.5 Hybrid', 2018, 2024),
          ...years('350 3.5', 2019, 2024),
        ],
      },
      {
        name: 'NX',
        variants: [
          ...years('300 2.0T', 2018, 2024),
          ...years('350h Hybrid', 2022, 2024),
        ],
      },
      {
        name: 'UX',
        variants: [...years('250h Hybrid', 2019, 2024)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // PORSCHE (imports)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Porsche',
    models: [
      {
        name: 'Cayenne',
        variants: [
          ...years('Base 3.0', 2018, 2024),
          ...years('S 2.9T', 2018, 2024),
          ...years('Turbo 4.0', 2018, 2024),
        ],
      },
      {
        name: 'Macan',
        variants: [
          ...years('Base 2.0', 2018, 2024),
          ...years('S 3.0', 2018, 2024),
        ],
      },
      {
        name: '911',
        variants: [
          ...years('Carrera 3.0T', 2019, 2024),
          ...years('Carrera S 3.0T', 2019, 2024),
          ...years('Turbo S 3.8T', 2020, 2024),
        ],
      },
      {
        name: 'Taycan',
        variants: [
          ...years('4S', 2021, 2024),
          ...years('Turbo S', 2021, 2024),
        ],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // LAND ROVER (imports)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Land Rover',
    models: [
      {
        name: 'Range Rover',
        variants: [
          ...years('Vogue 3.0', 2018, 2024),
          ...years('Autobiography 5.0', 2018, 2024),
        ],
      },
      {
        name: 'Range Rover Sport',
        variants: [...years('HSE 3.0', 2018, 2024)],
      },
      {
        name: 'Range Rover Velar',
        variants: [...years('R-Dynamic 2.0', 2018, 2024)],
      },
      {
        name: 'Range Rover Evoque',
        variants: [...years('SE 2.0', 2018, 2024)],
      },
      {
        name: 'Defender',
        variants: [
          ...years('110 P300', 2020, 2024),
          ...years('110 P400', 2020, 2024),
        ],
      },
      {
        name: 'Discovery',
        variants: [...years('HSE 3.0', 2018, 2023)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // JEEP (imports)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Jeep',
    models: [
      {
        name: 'Wrangler',
        variants: [
          ...years('Rubicon 3.6', 2019, 2024),
          ...years('Sahara 3.6', 2019, 2024),
        ],
      },
      {
        name: 'Grand Cherokee',
        variants: [...years('Limited 3.6', 2019, 2024)],
      },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // FORD (imports)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    make: 'Ford',
    models: [
      {
        name: 'Mustang',
        variants: [
          ...years('EcoBoost 2.3', 2018, 2023),
          ...years('GT 5.0', 2018, 2023),
        ],
      },
      {
        name: 'Ranger',
        variants: [
          ...years('Wildtrak 2.0 Bi-Turbo', 2019, 2024),
          ...years('Raptor 2.0 Bi-Turbo', 2019, 2024),
        ],
      },
      {
        name: 'Explorer',
        variants: [...years('Limited 2.3T', 2019, 2023)],
      },
    ],
  },
];

async function seedCars() {
  try {
    const mongoUri =
      process.env.MONGO_URI || 'mongodb://localhost:27017/hamzaMobile';
    await mongoose.connect(mongoUri);
    console.log('âœ… Connected to MongoDB');

    let createdCount = 0;
    let skippedCount = 0;
    const byMake = {};

    for (const makeEntry of carsData) {
      const make = titleCase(makeEntry.make);
      byMake[make] = 0;

      for (const modelEntry of makeEntry.models) {
        const model = titleCase(modelEntry.name);

        for (const { variant: rawVariant = '', year = null } of modelEntry.variants) {
          const variant = String(rawVariant || '').trim();

          const existing = await Car.findOne({ make, model, variant, year });

          if (existing) {
            skippedCount++;
            continue;
          }

          try {
            await Car.create({
              make,
              model,
              variant,
              year,
              active: true,
            });
            createdCount++;
            byMake[make]++;
          } catch (err) {
            // 11000 = duplicate key (hit the unique compound index)
            if (err && err.code === 11000) {
              skippedCount++;
              continue;
            }
            throw err;
          }
        }
      }
    }

    console.log('\n========================================');
    console.log('Cars seeded successfully!');
    console.log(`Created: ${createdCount}`);
    console.log(`Skipped (already exist): ${skippedCount}`);
    console.log('========================================\n');

    console.log('Per-make created this run:');
    Object.entries(byMake)
      .sort((a, b) => b[1] - a[1])
      .forEach(([make, count]) => {
        if (count > 0) console.log(`  - ${make}: ${count}`);
      });

    // Totals
    const totalCars = await Car.countDocuments();
    const activeCars = await Car.countDocuments({ active: true });
    const distinctMakes = (await Car.distinct('make')).length;
    console.log(`\nTotal cars in DB: ${totalCars}`);
    console.log(`Active: ${activeCars}`);
    console.log(`Distinct makes: ${distinctMakes}`);
  } catch (error) {
    console.error('âŒ Error seeding cars:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

seedCars();
