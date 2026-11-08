<script setup lang="ts">
// Editing a book: every field is a zubra element bound with v-model, saved through the API.
import MoneyInput from '~~/zubra/money-input.zb';
import QuantityStepper from '~~/zubra/quantity-stepper.zb';
import TagInput from '~~/zubra/tag-input.zb';
import ToggleSwitch from '~~/zubra/toggle-switch.zb';
import StockMeter from '~~/zubra/stock-meter.zb';

const route = useRoute();
const { data: book, error } = await useFetch(`/api/books/${route.params.id}`);
if (error.value) throw createError({ statusCode: 404, statusMessage: 'No such book', fatal: true });

const draft = reactive({ price: book.value!.price, stock: book.value!.stock, tags: [...book.value!.tags], featured: book.value!.featured });
const saving = ref(false);
const saved = ref('');
const errors = ref<Record<string, string>>({});
const changed = computed(() => JSON.stringify(draft) !== JSON.stringify({ price: book.value!.price, stock: book.value!.stock, tags: book.value!.tags, featured: book.value!.featured }));

async function save() {
  saving.value = true;
  errors.value = {};
  try {
    book.value = await $fetch(`/api/books/${route.params.id}`, { method: 'PUT', body: { ...draft } });
    saved.value = 'Saved.';
  } catch (failure: any) {
    errors.value = failure?.data?.data ?? { form: 'Could not save.' };
    saved.value = '';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <p class="muted"><NuxtLink to="/">Books</NuxtLink> / {{ book!.title }}</p>
  <h1>{{ book!.title }}</h1>
  <p class="muted">{{ book!.author }} · {{ book!.genre }}</p>
  <form class="edit" @submit.prevent="save">
    <label class="field">Price
      <MoneyInput v-model="draft.price" label="Price" :min="0.01" />
      <span v-if="errors.price" class="error">{{ errors.price }}</span>
    </label>
    <div class="field">Stock
      <div class="stock">
        <QuantityStepper v-model="draft.stock" label="copies" :min="0" :max="999" />
        <StockMeter :stock="draft.stock" :reorder="book!.reorder" :max="20" />
      </div>
      <span v-if="errors.stock" class="error">{{ errors.stock }}</span>
    </div>
    <div class="field">Tags
      <TagInput v-model="draft.tags" :suggestions="['bestseller', 'signed', 'staff-pick', 'sale']" :max="6" label="Tags" />
    </div>
    <ToggleSwitch v-model:checked="draft.featured" label="Featured" description="Show it on the shop's front page." />
    <div class="row">
      <button class="button" :disabled="saving || !changed">{{ saving ? 'Saving…' : 'Save' }}</button>
      <span v-if="saved && !changed" role="status" class="ok">{{ saved }}</span>
      <span v-if="errors.form" class="error">{{ errors.form }}</span>
    </div>
  </form>
</template>
