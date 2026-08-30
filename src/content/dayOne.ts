import type {
  BuyerTask,
  CustomerTask,
  PreviewCard,
  Product,
  SkillId,
} from "../domain/types";

export const CONTENT_VERSION = "vertical-slice-day1@0.1.0";

export const products: Record<string, Product> = {
  water: {
    id: "water",
    nameEn: "Sparkling water",
    nameZh: "气泡水",
    unitEn: "bottle",
    pricePence: 100,
    costPence: 50,
    shelfId: "chiller",
    colour: 0x6fa6b8,
  },
  milk: {
    id: "milk",
    nameEn: "Milk",
    nameZh: "牛奶",
    unitEn: "carton",
    pricePence: 150,
    costPence: 85,
    shelfId: "chiller",
    colour: 0xf0eee3,
  },
  crisps: {
    id: "crisps",
    nameEn: "Crisps",
    nameZh: "薯片",
    unitEn: "packet",
    pricePence: 120,
    costPence: 55,
    shelfId: "snacks",
    colour: 0xd6a026,
  },
};

export const previewCards: PreviewCard[] = [
  {
    id: "preview.request",
    phrase: "I'd like four bottles of water, please.",
    translation: "我想要四瓶水。",
    note: "进货时说明商品与数量",
    accent: "sage",
  },
  {
    id: "preview.checkout",
    phrase: "Would you like a bag or a receipt?",
    translation: "您需要袋子或收据吗？",
    note: "结账时确认顾客需求",
    accent: "mustard",
  },
  {
    id: "preview.payment",
    phrase: "Cash or card? — By card, please.",
    translation: "现金还是刷卡？——刷卡，谢谢。",
    note: "确认付款方式",
    accent: "navy",
  },
  {
    id: "preview.repeat",
    phrase: "Could you say that again, please?",
    translation: "能请您再说一遍吗？",
    note: "没听清时继续沟通",
    accent: "terracotta",
  },
];

export const buyerTask: BuyerTask = {
  id: "day1.buyer.restock-water",
  supplierLine: "Morning. What would you like?",
  instruction: "点击词块，向供货商订购 4 瓶气泡水。",
  chips: [
    { id: "chip-two", text: "two", semantic: "quantity:2" },
    { id: "chip-water", text: "bottles of water", semantic: "product:water" },
    { id: "chip-start", text: "I'd like", semantic: "intent:request" },
    { id: "chip-milk", text: "cartons of milk", semantic: "product:milk" },
    { id: "chip-four", text: "four", semantic: "quantity:4" },
    { id: "chip-please", text: "please.", semantic: "polite:please" },
  ],
  expectedSemanticOrder: [
    "intent:request",
    "quantity:4",
    "product:water",
    "polite:please",
  ],
  confirmationLine: "Four bottles of water. Is that right?",
  productId: "water",
  quantity: 4,
  hints: [
    "先说自己的需求，再说数量和商品。",
    "进货单上写的是 4 × water。",
    "正确顺序：I'd like → four → bottles of water → please.",
  ],
  skillId: "buyer.request_item_quantity",
};

export const customers: CustomerTask[] = [
  {
    id: "day1.seller.customer-01-milk",
    name: "Oliver",
    avatarColour: 0x8e5d48,
    prompt: "Can I have one carton of milk, please?",
    translation: "我可以买一盒牛奶吗？",
    simplifiedPrompt: "One carton of milk, please.",
    expectedOrder: { productId: "milk", quantity: 1 },
    orderOptions: [
      {
        id: "milk-one",
        label: "1 carton of milk",
        detail: "一盒牛奶",
        slots: { productId: "milk", quantity: 1 },
      },
      {
        id: "milk-two",
        label: "2 cartons of milk",
        detail: "两盒牛奶",
        slots: { productId: "milk", quantity: 2 },
      },
      {
        id: "crisps-one",
        label: "1 packet of crisps",
        detail: "一包薯片",
        slots: { productId: "crisps", quantity: 1 },
      },
    ],
    productId: "milk",
    quantity: 1,
    shelfId: "chiller",
    baseRevenuePence: 150,
    accuracyBonusPence: 20,
    skillId: "seller.understand_item_quantity",
    variant: false,
    hints: [
      "先找出商品，再确认数量。",
      "关键词：ONE · CARTON · MILK",
      "请选择 1 carton of milk。",
    ],
  },
  {
    id: "day1.seller.customer-02-checkout",
    name: "Amara",
    avatarColour: 0x4d7180,
    prompt: "A packet of crisps, please.",
    translation: "请给我一包薯片。",
    simplifiedPrompt: "One packet of crisps.",
    expectedOrder: { productId: "crisps", quantity: 1 },
    orderOptions: [
      {
        id: "crisps-one",
        label: "1 packet of crisps",
        detail: "一包薯片",
        slots: { productId: "crisps", quantity: 1 },
      },
      {
        id: "water-one",
        label: "1 bottle of water",
        detail: "一瓶水",
        slots: { productId: "water", quantity: 1 },
      },
      {
        id: "crisps-two",
        label: "2 packets of crisps",
        detail: "两包薯片",
        slots: { productId: "crisps", quantity: 2 },
      },
    ],
    productId: "crisps",
    quantity: 1,
    shelfId: "snacks",
    baseRevenuePence: 120,
    accuracyBonusPence: 20,
    skillId: "seller.checkout_details",
    variant: false,
    checkout: {
      customerLine:
        "No bag, thanks. Could I have a receipt? I'll pay by card.",
      expectedSlots: { bag: false, receipt: true, payment: "card" },
      options: [
        {
          id: "checkout-correct",
          label: "No bag · Receipt · Card",
          detail: "不要袋子 · 要收据 · 刷卡",
          slots: { bag: false, receipt: true, payment: "card" },
        },
        {
          id: "checkout-bag",
          label: "Bag · Receipt · Card",
          detail: "要袋子 · 要收据 · 刷卡",
          slots: { bag: true, receipt: true, payment: "card" },
        },
        {
          id: "checkout-cash",
          label: "No bag · No receipt · Cash",
          detail: "不要袋子 · 不要收据 · 现金",
          slots: { bag: false, receipt: false, payment: "cash" },
        },
      ],
    },
    hints: [
      "分别听袋子、收据和付款方式。",
      "关键词：NO BAG · RECEIPT · CARD",
      "请选择 No bag · Receipt · Card。",
    ],
  },
  {
    id: "day1.seller.customer-03-repair",
    name: "George",
    avatarColour: 0x65724b,
    prompt: "Could I get two bottles of water, please?",
    translation: "我可以买两瓶水吗？",
    simplifiedPrompt: "Two bottles of water, please.",
    expectedOrder: { productId: "water", quantity: 2 },
    orderOptions: [
      {
        id: "water-two",
        label: "2 bottles of water",
        detail: "两瓶水",
        slots: { productId: "water", quantity: 2 },
      },
      {
        id: "water-three",
        label: "3 bottles of water",
        detail: "三瓶水",
        slots: { productId: "water", quantity: 3 },
      },
      {
        id: "milk-two",
        label: "2 cartons of milk",
        detail: "两盒牛奶",
        slots: { productId: "milk", quantity: 2 },
      },
    ],
    productId: "water",
    quantity: 2,
    shelfId: "chiller",
    baseRevenuePence: 200,
    accuracyBonusPence: 20,
    skillId: "seller.understand_item_quantity",
    variant: true,
    repairScenario: true,
    checkout: {
      customerLine: "A bag, please. I'll pay cash. No receipt, thanks.",
      expectedSlots: { bag: true, receipt: false, payment: "cash" },
      options: [
        {
          id: "checkout-correct",
          label: "Bag · No receipt · Cash",
          detail: "要袋子 · 不要收据 · 现金",
          slots: { bag: true, receipt: false, payment: "cash" },
        },
        {
          id: "checkout-card",
          label: "Bag · Receipt · Card",
          detail: "要袋子 · 要收据 · 刷卡",
          slots: { bag: true, receipt: true, payment: "card" },
        },
        {
          id: "checkout-no-bag",
          label: "No bag · No receipt · Cash",
          detail: "不要袋子 · 不要收据 · 现金",
          slots: { bag: false, receipt: false, payment: "cash" },
        },
      ],
    },
    hints: [
      "没听清时，不要猜。先请顾客重复。",
      "可以说：Could you say that again, please?",
      "重复后留意 TWO · BOTTLES · WATER。",
    ],
  },
];

export const skillLabels: Record<SkillId, { en: string; zh: string }> = {
  "buyer.request_item_quantity": {
    en: "Request an item and quantity",
    zh: "主动说明商品与数量",
  },
  "seller.understand_item_quantity": {
    en: "Understand item and quantity",
    zh: "听懂商品与数量",
  },
  "seller.checkout_details": {
    en: "Confirm checkout details",
    zh: "确认结账信息",
  },
  "repair.request_repetition": {
    en: "Ask for repetition",
    zh: "请求对方重复",
  },
};
