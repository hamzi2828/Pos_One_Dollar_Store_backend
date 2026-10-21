// src/constants/websiteDefaults.js
// Default content of the marketing website (first load, and "Reset to default").
// The website keeps the SAME copy in dollar_website/lib/defaults.ts as its
// offline fallback — change both together. See docs/WEBSITE_CMS.md §1.
//
// Truthful only: no address, phone, hours or social links by default (the
// owner fills them in). Return policy is "ask at the counter", not invented.

// Fixed icon keys (both apps map them to icons).
const WEBSITE_ICONS = Object.freeze([
  'store', 'tag', 'wallet', 'gift', 'sparkles', 'home',
  'kitchen', 'toys', 'beauty', 'stationery', 'cleaning', 'truck',
  'clock', 'heart', 'star', 'smile', 'shield', 'users', 'package', 'percent',
]);

const WEBSITE_DEFAULTS = {
  brand: {
    name: 'DOLLAR & Co',
    tagline: "Everything you need, at prices you'll love",
  },
  hero: {
    heading: 'Everything for your home. Everything Rs 300.',
    subheading: 'Kitchen, home decor, storage, cleaning, bath, stationery, toys, beauty and gifts — one fixed price for every item, no bargaining.',
    imageUrl: '/images/storefront-shop.jpg',
    videoUrl: '',
    primaryCta: { label: 'Visit the shop', url: '#visit' },
    secondaryCta: { label: "What you'll find", url: '#categories' },
  },
  about: {
    show: true,
    heading: 'Who we are',
    body:
      'DOLLAR & Co is a modern fixed-price store for everyday things. We keep shopping simple: every item has a clear price, so you know what you will pay before you reach the counter.\n\n' +
      'We stock the things a home needs, from kitchen and dining to storage, cleaning, bath, stationery, toys, beauty and gifts. And we keep adding new stock, so there is always something new to see.',
    imageUrl: '',
  },
  whatWeDo: {
    show: true,
    heading: 'What we do',
    intro: 'A bright, tidy shop full of useful things, sorted so they are easy to find.',
    items: [
      { icon: 'store', title: 'Everyday essentials', text: 'Kitchen, home, bath and cleaning items you use every day, all under one roof.' },
      { icon: 'tag', title: 'One price: Rs 300', text: 'Every item in the shop costs the same: Rs 300. No guessing, no bargaining.' },
      { icon: 'package', title: 'New stock regularly', text: 'We bring in new items often, so there is always something new on the racks.' },
      { icon: 'gift', title: 'Gifts and little extras', text: 'Small gifts, toys and seasonal items for birthdays, festivals and everyday treats.' },
    ],
  },
  whatYouGet: {
    show: true,
    heading: 'What you get',
    intro: 'Simple promises we keep every day.',
    items: [
      { icon: 'tag', title: 'Clear, fixed prices', text: 'The price on the rack is the price at the counter.' },
      { icon: 'sparkles', title: 'New stock regularly', text: "Fresh items arrive often. Come back and see what's new." },
      { icon: 'shield', title: 'Quality checked', text: 'We check our items before they go on the shelf.' },
      { icon: 'wallet', title: 'A bill with every purchase', text: 'Every sale goes through our till, so you always get a proper bill.' },
      { icon: 'home', title: 'Easy to find', text: 'Clearly marked racks (A to D) help you find things quickly.' },
      { icon: 'percent', title: 'Gifts and offers', text: "Offers like 10% off on bigger shopping. See in store for today's offers." },
    ],
  },
  prices: {
    show: true,
    heading: 'One simple price',
    intro: 'One price for everything. Pick anything you like, it is Rs 300.',
    items: [{ price: 300, label: 'Everything', note: 'Every item, one price' }],
  },
  categories: {
    show: true,
    heading: "What you'll find",
    items: [
      { name: 'Kitchen & Dining', text: 'Kitchen tools, containers, cups and serving pieces.', imageUrl: '' },
      { name: 'Home Decor', text: 'Small touches that brighten up a room.', imageUrl: '' },
      { name: 'Storage & Organisers', text: 'Boxes, baskets and organisers for every corner.', imageUrl: '' },
      { name: 'Cleaning', text: 'Brushes, cloths and handy cleaning tools.', imageUrl: '' },
      { name: 'Bath', text: 'Bathroom basics and accessories.', imageUrl: '' },
      { name: 'Stationery', text: 'Notebooks, pens and school and office supplies.', imageUrl: '' },
      { name: 'Toys', text: 'Fun, affordable toys for children.', imageUrl: '' },
      { name: 'Beauty & Personal Care', text: 'Everyday beauty and personal care items.', imageUrl: '' },
      { name: 'Gifts', text: 'Small gifts for any occasion.', imageUrl: '' },
      { name: 'Plastic Ware', text: 'Practical plastic items for the home and kitchen.', imageUrl: '' },
      { name: 'Seasonal', text: 'Items for the season and for festivals.', imageUrl: '' },
    ],
  },
  // Not shown on the website (owner removed the Offers section).
  offers: {
    show: false,
    heading: 'Offers',
    items: [],
  },
  gallery: {
    show: true,
    heading: 'Inside the shop',
    items: [],
  },
  faq: {
    show: true,
    heading: 'Questions',
    items: [
      { q: 'Are all prices fixed?', a: 'Yes. Every item has a clear fixed price, so you know what you will pay before you reach the counter.' },
      { q: 'What are your prices?', a: 'Everything is Rs 300. One fixed price for every item.' },
      { q: 'Do you have new stock?', a: "Yes, we add new stock regularly. Follow our Facebook page to see what's new." },
      { q: 'Do I get a bill?', a: 'Yes, every purchase comes with a bill from our till.' },
      { q: 'Do you have offers?', a: "We run offers from time to time, like 10% off on bigger shopping. Ask in store for today's offers." },
      { q: 'Can I return an item?', a: 'Please ask at the counter, and keep your bill with you.' },
    ],
  },
  visit: {
    show: true,
    heading: 'Visit us',
    address: '',
    city: '',
    mapEmbedUrl: '',
    mapLinkUrl: '',
    hours: '',
    phone: '',
    whatsapp: '',
    email: '',
  },
  social: {
    facebookUrl: '',
    instagramUrl: '',
    tiktokUrl: '',
    youtubeUrl: '',
    showFacebookFeed: true,
  },
  seo: {
    title: 'DOLLAR & Co | Everything Rs 300',
    description:
      'DOLLAR & Co is a modern fixed-price store for kitchen, home, cleaning, stationery, toys, beauty and gifts. One fixed price: everything is Rs 300.',
    ogImageUrl: '/images/og.jpg',
    keywords: 'Rs 300 store, everything Rs 300, Mirpur, dollar store, fixed price store, household items, kitchen, home decor, gifts, toys, stationery, Pakistan',
  },
  siteUrl: '',
};

// Deep-freeze so nobody mutates the shared defaults by accident.
const deepFreeze = (o) => {
  Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v));
  return Object.freeze(o);
};
deepFreeze(WEBSITE_DEFAULTS);

module.exports = { WEBSITE_DEFAULTS, WEBSITE_ICONS };
