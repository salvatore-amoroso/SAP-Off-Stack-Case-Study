CLASS lcx_bl_poll IMPLEMENTATION.
  METHOD constructor.
    super->constructor( ).
    me->code = code.
  ENDMETHOD.
ENDCLASS.

CLASS lcl_bl_clock IMPLEMENTATION.
  METHOD constructor.
    timer = COND #( WHEN runtime IS BOUND THEN runtime ELSE cl_abap_runtime=>create_hr_timer( ) ).
    previous = timer->get_runtime( ).
  ENDMETHOD.
  METHOD now.
    DATA(current) = timer->get_runtime( ).
    DATA(delta) = CONV int8( current ) - previous.
    IF delta < 0.
      delta += 4294967296.
    ENDIF.
    accumulated += delta.
    previous = current.
    microseconds = accumulated.
  ENDMETHOD.
ENDCLASS.
