DROP POLICY IF EXISTS select_policy ON public.inventory_items;
CREATE POLICY select_policy ON public.inventory_items
FOR SELECT TO public
USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS select_policy ON public.private_order_items;
CREATE POLICY select_policy ON public.private_order_items
FOR SELECT TO public
USING (deleted_at IS NULL OR public.is_owner(auth.uid()));
