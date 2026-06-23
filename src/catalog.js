export const categories = [
  { id: "tiers", label: "Sponsorship tiers" },
  { id: "booths", label: "Booths" },
  { id: "programming", label: "Programming" },
  { id: "digital", label: "Digital & experience" },
  { id: "meals", label: "Breaks & meals" },
  { id: "branded", label: "Branded items" },
  { id: "student", label: "Student & community" }
];

export const packages = [
  {
    id: "tier-title",
    category: "tiers",
    name: "Title",
    label: "Presenting",
    price: 25000,
    availability: "1 only",
    summary: "Anchor the full meeting with top billing and a signature event.",
    included: [
      "Title branding on meeting materials and co-branded lanyards",
      "Top website logo and full-page color program ad",
      "Premium 2-booth corner block and 8 full registrations",
      "Opening Ceremony remarks and networking event of choice"
    ]
  },
  {
    id: "tier-platinum",
    category: "tiers",
    name: "Platinum",
    price: 10000,
    availability: "up to 3",
    summary: "High-visibility sponsor presence with a marquee meeting item.",
    included: [
      "Choice of Welcome Reception, Awards Banquet, or conference tote bags",
      "Premium booth, 5 full registrations, full-page program ad",
      "Logo on signage and pre-plenary slide reel",
      "Opening Ceremony recognition and exhibitor workshop slot"
    ]
  },
  {
    id: "tier-gold",
    category: "tiers",
    name: "Gold",
    price: 5000,
    availability: "up to 6",
    summary: "Strong booth, program, and digital visibility across the meeting.",
    included: [
      "Choice of coffee break, breakfast, or symposium series",
      "Standard 8' x 10' booth and 3 full registrations",
      "Half-page program ad",
      "Logo on website, signage, and pre-plenary slide reel"
    ]
  },
  {
    id: "tier-silver",
    category: "tiers",
    name: "Silver",
    price: 2500,
    availability: "unlimited",
    summary: "Exhibitor package with program and meeting signage recognition.",
    included: [
      "8' x 10' booth and 1 full registration",
      "Quarter-page program ad",
      "Logo on website, program book, signage, and slide reel"
    ]
  },
  {
    id: "tier-bronze",
    category: "tiers",
    name: "Bronze",
    price: 1000,
    availability: "unlimited",
    summary: "Digital and on-site sponsor recognition for regional visibility.",
    included: [
      "Linked logo on website",
      "Program book and signage recognition",
      "Pre-plenary slide reel and social-media recognition"
    ]
  },
  {
    id: "tier-friend",
    category: "tiers",
    name: "Friend of SWRM",
    price: 500,
    availability: "unlimited",
    summary: "Logo recognition for smaller organizations and supporters.",
    included: ["Logo on website", "Logo in program book"]
  },
  {
    id: "tier-supporter",
    category: "tiers",
    name: "Supporter",
    price: 250,
    availability: "unlimited",
    summary: "Entry-level recognition in meeting materials.",
    included: ["Pre-plenary slide reel recognition", "Program book listing"]
  },
  {
    id: "booth-standard-early",
    category: "booths",
    name: "Standard 8' x 10' commercial booth",
    label: "early bird through Aug 1",
    price: 1500,
    availability: "deadline priced",
    summary: "Commercial exhibit booth with table, chairs, power, and badges.",
    included: [
      "Carpeted booth with pipe-and-drape",
      "6' skirted table, two chairs, printed identification sign",
      "110V power and overhead lighting",
      "Two complimentary exhibitor registrations"
    ]
  },
  {
    id: "booth-standard",
    category: "booths",
    name: "Standard 8' x 10' commercial booth",
    label: "after Aug 1",
    price: 1700,
    availability: "available until Sep 15",
    summary: "Commercial exhibit booth after the early-bird deadline.",
    included: ["Standard booth package", "Two exhibitor registrations"]
  },
  {
    id: "booth-premium-corner",
    category: "booths",
    name: "Premium / corner upgrade",
    price: 300,
    availability: "add-on",
    summary: "Upgrade a booth selection to a premium or corner location.",
    included: ["First-paid, first-served booth assignment"]
  },
  {
    id: "booth-academic-grad",
    category: "booths",
    name: "Academic / Grad Fair booth",
    label: "early bird $350",
    price: 500,
    availability: "available",
    summary: "Lower-cost booth package for academic and grad-fair exhibitors.",
    included: ["Academic recruiting or outreach presence"]
  },
  {
    id: "booth-nonprofit",
    category: "booths",
    name: "Non-profit booth",
    price: 500,
    availability: "available",
    summary: "Exhibit space for non-profit organizations.",
    included: ["Standard non-profit exhibitor presence"]
  },
  {
    id: "programming-plenary",
    category: "programming",
    name: "Plenary Lecture Sponsor",
    price: 5000,
    availability: "limited",
    summary: "Associate your organization with a major plenary lecture.",
    included: ["Lecture recognition", "Program and slide-reel visibility"]
  },
  {
    id: "programming-keynote",
    category: "programming",
    name: "Keynote Speaker Sponsor",
    price: 3500,
    availability: "limited",
    summary: "Sponsor a keynote speaker moment during the meeting.",
    included: ["Speaker-session recognition", "Meeting materials visibility"]
  },
  {
    id: "programming-panel",
    category: "programming",
    name: "Industry-Academia Panel",
    price: 2500,
    availability: "limited",
    summary: "Support a forum connecting research, hiring, and applications.",
    included: ["Panel recognition", "Program listing"]
  },
  {
    id: "programming-workshop",
    category: "programming",
    name: "Demonstration Room / Workshop",
    label: "per hour",
    price: 1500,
    availability: "hourly",
    summary: "Reserve a demonstration or workshop slot for technical outreach.",
    included: ["One-hour exhibitor workshop or demonstration room slot"]
  },
  {
    id: "programming-full-day",
    category: "programming",
    name: "Full-Day Symposium Naming",
    price: 1000,
    availability: "limited",
    summary: "Attach your brand to a full-day symposium program.",
    included: ["Symposium naming recognition"]
  },
  {
    id: "programming-half-day",
    category: "programming",
    name: "Half-Day Symposium Naming",
    price: 500,
    availability: "limited",
    summary: "Support a half-day symposium track.",
    included: ["Symposium naming recognition"]
  },
  {
    id: "digital-wifi",
    category: "digital",
    name: "Wi-Fi",
    label: "exclusive",
    price: 7500,
    availability: "E",
    summary: "Exclusive visibility on the attendee connectivity experience.",
    included: ["Exclusive Wi-Fi sponsor recognition"]
  },
  {
    id: "digital-floor-decals",
    category: "digital",
    name: "Floor Decals",
    label: "set of 5",
    price: 2500,
    availability: "available",
    summary: "Guide attendee movement with branded floor visibility.",
    included: ["Five branded floor decals"]
  },
  {
    id: "digital-charging",
    category: "digital",
    name: "Charging Station",
    price: 2500,
    availability: "2 available",
    summary: "Brand a practical attendee touchpoint.",
    included: ["Charging station sponsor signage"]
  },
  {
    id: "digital-photo-booth",
    category: "digital",
    name: "Photo Booth",
    price: 2000,
    availability: "available",
    summary: "Sponsor a shareable attendee experience.",
    included: ["Photo booth sponsor recognition"]
  },
  {
    id: "meals-opening-reception",
    category: "meals",
    name: "Opening Reception",
    label: "exclusive",
    price: 10000,
    availability: "E",
    summary: "Sponsor the opening reception for broad attendee exposure.",
    included: ["Exclusive reception recognition"]
  },
  {
    id: "meals-awards",
    category: "meals",
    name: "Awards Banquet / Luncheon",
    label: "exclusive",
    price: 10000,
    availability: "E",
    summary: "Sponsor an awards meal moment with high attendee attention.",
    included: ["Exclusive banquet or luncheon recognition"]
  },
  {
    id: "meals-scimix",
    category: "meals",
    name: "Closing / Sci-Mix Reception",
    price: 7500,
    availability: "limited",
    summary: "Support the closing networking and science-mix reception.",
    included: ["Reception recognition"]
  },
  {
    id: "meals-plenary-lunch",
    category: "meals",
    name: "Plenary Luncheon",
    label: "2 days available",
    price: 5000,
    availability: "2 available",
    summary: "Sponsor a lunch tied to plenary programming.",
    included: ["Luncheon recognition"]
  },
  {
    id: "meals-hospitality",
    category: "meals",
    name: "Hospitality Suite",
    price: 5000,
    availability: "limited",
    summary: "Support an informal networking destination.",
    included: ["Hospitality suite sponsor recognition"]
  },
  {
    id: "meals-grad-mixer",
    category: "meals",
    name: "Graduate Student Mixer",
    price: 3500,
    availability: "limited",
    summary: "Reach graduate students and early-career scientists directly.",
    included: ["Mixer recognition"]
  },
  {
    id: "meals-breakfast",
    category: "meals",
    name: "Sponsored Breakfast",
    price: 2500,
    availability: "limited",
    summary: "Sponsor a breakfast gathering during the meeting.",
    included: ["Breakfast sponsor signage and program recognition"]
  },
  {
    id: "meals-coffee-break",
    category: "meals",
    name: "Coffee Break",
    price: 2000,
    availability: "availability TBD",
    summary: "Sponsor a high-traffic coffee break attendee touchpoint.",
    included: ["Coffee break signage and program recognition"]
  },
  {
    id: "branded-tote-bags",
    category: "branded",
    name: "Tote Bags",
    price: 5000,
    availability: "limited",
    summary: "Put your brand on a widely carried attendee item.",
    included: ["Conference tote bag sponsor recognition"]
  },
  {
    id: "branded-lanyards",
    category: "branded",
    name: "Lanyards",
    price: 5000,
    availability: "limited",
    summary: "High-frequency sponsor visibility on attendee lanyards.",
    included: ["Lanyard sponsor recognition"]
  },
  {
    id: "branded-water-bottles",
    category: "branded",
    name: "Water Bottles",
    price: 5000,
    availability: "limited",
    summary: "Brand a practical attendee item.",
    included: ["Water bottle sponsor recognition"]
  },
  {
    id: "branded-badges",
    category: "branded",
    name: "Badges & Badge Holders",
    price: 3500,
    availability: "limited",
    summary: "Sponsor a credential item every attendee uses.",
    included: ["Badge and badge holder sponsor recognition"]
  },
  {
    id: "branded-notepads",
    category: "branded",
    name: "Notepads & Pens",
    price: 2500,
    availability: "limited",
    summary: "Put your brand into attendee note-taking moments.",
    included: ["Notepad and pen sponsor recognition"]
  },
  {
    id: "branded-full-ad",
    category: "branded",
    name: "Full-Page Program Ad",
    price: 1500,
    availability: "available",
    summary: "Reserve a full-page color ad in the program.",
    included: ["Full-page program advertisement"]
  },
  {
    id: "branded-half-ad",
    category: "branded",
    name: "Half-Page Program Ad",
    price: 800,
    availability: "available",
    summary: "Reserve a half-page program ad.",
    included: ["Half-page program advertisement"]
  },
  {
    id: "branded-quarter-ad",
    category: "branded",
    name: "Quarter-Page Program Ad",
    price: 500,
    availability: "available",
    summary: "Reserve a quarter-page program ad.",
    included: ["Quarter-page program advertisement"]
  },
  {
    id: "student-fun-run",
    category: "student",
    name: "5K Fun Run",
    price: 2500,
    availability: "available",
    summary: "Support a community wellness activity.",
    included: ["Fun run sponsor recognition"]
  },
  {
    id: "student-tour",
    category: "student",
    name: "Local Tour Sponsor",
    price: 1500,
    availability: "available",
    summary: "Sponsor attendee connection to Fort Worth.",
    included: ["Local tour sponsor recognition"]
  },
  {
    id: "student-travel-award",
    category: "student",
    name: "Undergraduate Travel Award",
    label: "named, each",
    price: 500,
    availability: "multiple",
    summary: "Fund named undergraduate travel support.",
    included: ["Named undergraduate travel award"]
  },
  {
    id: "student-teacher-reg",
    category: "student",
    name: "High-School Teacher Registration",
    label: "each",
    price: 500,
    availability: "multiple",
    summary: "Cover registration for a high-school teacher participant.",
    included: ["Teacher registration support"]
  },
  {
    id: "student-poster-prize",
    category: "student",
    name: "Undergraduate Poster Prize",
    label: "each",
    price: 250,
    availability: "multiple",
    summary: "Sponsor undergraduate poster prize recognition.",
    included: ["Named undergraduate poster prize"]
  }
];

export const catalogById = new Map(packages.map((item) => [item.id, item]));

export function inferInitialStock(item) {
  const availability = `${item.availability || ""} ${item.label || ""}`.toLowerCase();
  const upToMatch = availability.match(/up to\s+(\d+)/);
  const availableMatch = availability.match(/(\d+)\s+available/);

  if (availability.includes("unlimited") || availability.includes("multiple")) return null;
  if (availability.includes("1 only") || availability.includes("exclusive")) return 1;
  if (item.availability === "E") return 1;
  if (upToMatch) return Number(upToMatch[1]);
  if (availableMatch) return Number(availableMatch[1]);
  return null;
}

export function withInventoryDefaults(item, index = 0) {
  const stock = inferInitialStock(item);

  return {
    ...item,
    priceCents: item.price * 100,
    stockTotal: stock,
    stockRemaining: stock,
    active: true,
    sortOrder: index
  };
}

export function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}
