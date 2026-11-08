<script setup lang="ts">
// The inventory: filtered on the server (Nitro's /api/books), with the genre picked in a zubra
// segmented control (v-model) and stock shown by the app's own stock-meter.
import SegmentedControl from '~~/zubra/segmented-control.zb';
import StockMeter from '~~/zubra/stock-meter.zb';

const route = useRoute();
const router = useRouter();
const genre = ref(String(route.query.genre ?? 'all'));
const q = ref(String(route.query.q ?? ''));
const { data: books } = await useFetch('/api/books', { query: { genre, q } });
watch(genre, (value) => router.replace({ query: { ...route.query, genre: value === 'all' ? undefined : value } }));
const genres = [
  { value: 'all', label: 'All' },
  { value: 'fiction', label: 'Fiction' },
  { value: 'nonfiction', label: 'Nonfiction' },
  { value: 'kids', label: 'Kids' },
];
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
</script>

<template>
  <h1>Books</h1>
  <div class="filters">
    <SegmentedControl v-model="genre" :options="genres" label="Genre" />
    <input v-model.lazy="q" type="search" placeholder="Title, author or tag" aria-label="Search books">
  </div>
  <p class="muted count">{{ books?.length ?? 0 }} books</p>
  <ul class="books">
    <li v-for="book in books" :key="book.id" :data-id="book.id">
      <div>
        <NuxtLink :to="`/books/${book.id}`" class="title">{{ book.title }}</NuxtLink>
        <span v-if="book.featured" class="featured">Featured</span>
        <p class="muted">{{ book.author }} · {{ book.price == null ? 'No price' : money.format(book.price) }}</p>
      </div>
      <StockMeter :stock="book.stock" :reorder="book.reorder" :max="20" />
    </li>
  </ul>
</template>
